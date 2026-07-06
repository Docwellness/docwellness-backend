const {
  DietPlan,
  MealLog,
  DietPlanRequest,
  ManualPaymentProof,
  User,
  Conversation,
} = require('../../models');
const ConversationV1 = require('../../chat/models/ConversationV1');
const NeedAttentionLog = require('../../models/NeedAttentionLog');

/**
 * @route   GET /api/dietician/dashboard-stats
 * @desc    Get action tile stats for dietician home dashboard
 */
exports.getDashboardStats = async (req, res, next) => {
  try {
    const dieticianId = req.user._id;

    // 1. Messages Received — number of patients with unread messages
    //    Query both ConversationV1 (active system) and legacy Conversation collection.
    //    V1 unreadCount takes priority when the same patient exists in both.

    // V1 conversations
    const conversationsV1 = await ConversationV1.find({
      'participants.userId': dieticianId,
    }).lean();

    // Build V1 unread map: otherUserId -> unreadCount
    const v1UnreadByUser = {};
    conversationsV1.forEach((conv) => {
      const me = conv.participants.find((p) => p.userId.toString() === dieticianId.toString());
      const other = conv.participants.find((p) => p.userId.toString() !== dieticianId.toString());
      if (me && other) {
        v1UnreadByUser[other.userId.toString()] = me.unreadCount || 0;
      }
    });

    // Legacy conversations
    const legacyConversations = await Conversation.find({
      'participants.userId': dieticianId,
    })
      .populate('participants.userId', '_id')
      .lean();

    // Merge: track unique patients with unread messages
    const unreadPatientSet = new Set();
    const messagesReceivedPatientIds = [];

    // Process legacy conversations first
    legacyConversations.forEach((conv) => {
      const me = conv.participants.find(
        (p) => p.userId && p.userId._id && p.userId._id.toString() === dieticianId.toString()
      );
      const other = conv.participants.find(
        (p) => p.userId && p.userId._id && p.userId._id.toString() !== dieticianId.toString()
      );
      if (!me || !other) return;

      const otherIdStr = other.userId._id.toString();
      // Use V1 unread if available (active system), else legacy
      const unread = v1UnreadByUser[otherIdStr] !== undefined
        ? v1UnreadByUser[otherIdStr]
        : (me.unreadCount || 0);

      if (unread > 0 && !unreadPatientSet.has(otherIdStr)) {
        unreadPatientSet.add(otherIdStr);
        messagesReceivedPatientIds.push(other.userId._id);
      }
    });

    // Add V1-only conversations (not in legacy)
    conversationsV1.forEach((conv) => {
      const me = conv.participants.find((p) => p.userId.toString() === dieticianId.toString());
      const other = conv.participants.find((p) => p.userId.toString() !== dieticianId.toString());
      if (!me || !other) return;

      const otherIdStr = other.userId.toString();
      if ((me.unreadCount || 0) > 0 && !unreadPatientSet.has(otherIdStr)) {
        unreadPatientSet.add(otherIdStr);
        messagesReceivedPatientIds.push(other.userId);
      }
    });

    let messagesReceived = messagesReceivedPatientIds.length;

    // 2. Review Logged Data — patients who logged meals today
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    // Get all patient IDs belonging to this dietician
    const dieticianRequests = await DietPlanRequest.find({
      dieticianId,
    })
      .select('_id patient')
      .lean();

    const patientIds = dieticianRequests.map((r) => r.patient);
    const requestIds = dieticianRequests.map((r) => r._id);

    const reviewLoggedDataCount = await MealLog.distinct('patientId', {
      patientId: { $in: patientIds },
      date: { $gte: todayStart, $lte: todayEnd },
    });
    const reviewLoggedData = reviewLoggedDataCount.length;
    const reviewLoggedPatientIds = reviewLoggedDataCount;

    // Revenue = sum of amount actually received for approved manual proofs
    let totalRevenue = 0;
    if (requestIds.length > 0) {
      const revenueAgg = await ManualPaymentProof.aggregate([
        {
          $match: {
            request: { $in: requestIds },
            status: 'Approved',
          },
        },
        {
          $group: {
            _id: null,
            totalRevenue: { $sum: '$amountReceived' },
          },
        },
      ]);

      totalRevenue = revenueAgg[0]?.totalRevenue || 0;
    }

    // 3. Clients close to end of membership — active diet plans ending within 7 days
    const sevenDaysFromNow = new Date();
    sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);

    const closingPlans = await DietPlan.find({
      dieticianId,
      status: 'Active',
      endDate: { $lte: sevenDaysFromNow, $gte: new Date() },
    }).select('patientId').lean();
    const closingClients = closingPlans.length;
    const closingPatientIds = closingPlans.map((p) => p.patientId);

    // 4. Did extremely well — patients who logged > 80% of planned calories yesterday
    const yesterdayStart = new Date();
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    yesterdayStart.setHours(0, 0, 0, 0);
    const yesterdayEnd = new Date();
    yesterdayEnd.setDate(yesterdayEnd.getDate() - 1);
    yesterdayEnd.setHours(23, 59, 59, 999);

    // Get active plans with calorie budgets
    const activePlans = await DietPlan.find({
      dieticianId,
      status: 'Active',
    })
      .select('patientId totalCalories calorieStrategy')
      .lean();

    const activePlanMap = {};
    activePlans.forEach((plan) => {
      const budget = plan.calorieStrategy?.calorieBudget || plan.totalCalories || 0;
      if (budget > 0) {
        activePlanMap[plan.patientId.toString()] = budget;
      }
    });

    const activePatientIds = Object.keys(activePlanMap);

    let didExtremelyWell = 0;
    let needAttention = 0;
    const didExtremelyWellIds = [];
    const needAttentionIds = [];

    if (activePatientIds.length > 0) {
      const yesterdayLogs = await MealLog.find({
        patientId: { $in: activePatientIds },
        date: { $gte: yesterdayStart, $lte: yesterdayEnd },
      })
        .select('patientId totalCalories')
        .lean();

      const loggedMap = {};
      yesterdayLogs.forEach((log) => {
        loggedMap[log.patientId.toString()] = log.totalCalories || 0;
      });

      activePatientIds.forEach((pid) => {
        const budget = activePlanMap[pid];
        const consumed = loggedMap[pid];
        // Skip patients with no log — they're handled below
        if (consumed === undefined) return;
        const ratio = consumed / budget;

        if (ratio >= 0.8 && ratio <= 1.2) {
          didExtremelyWell++;
          didExtremelyWellIds.push(pid);
        } else if (ratio < 0.5 || ratio > 1.5) {
          needAttention++;
          needAttentionIds.push(pid);
        }
      });

      // 5. Need Attention — also count patients with NO log at all yesterday
      const patientsWithLogs = new Set(Object.keys(loggedMap));
      activePatientIds.forEach((pid) => {
        if (!patientsWithLogs.has(pid)) {
          needAttention++;
          needAttentionIds.push(pid);
        }
      });
    }

    // Collect all unique patient IDs across categories and fetch names
    const allPids = new Set([
      ...messagesReceivedPatientIds.map((id) => id.toString()),
      ...reviewLoggedPatientIds.map((id) => id.toString()),
      ...closingPatientIds.map((id) => id.toString()),
      ...didExtremelyWellIds,
      ...needAttentionIds,
    ]);

    // --- Need Attention History ---
    // Log today's need-attention patients (upsert to avoid duplicates)
    const todayFlag = new Date();
    todayFlag.setHours(0, 0, 0, 0);

    if (needAttentionIds.length > 0) {
      const bulkOps = needAttentionIds.map((pid) => ({
        updateOne: {
          filter: { dieticianId, patientId: pid, flagDate: todayFlag },
          update: { $setOnInsert: { dieticianId, patientId: pid, flagDate: todayFlag } },
          upsert: true,
        },
      }));
      await NeedAttentionLog.bulkWrite(bulkOps).catch(() => { });
    }

    // Check which of today's flagged patients have been acknowledged (read)
    const todayLogs = await NeedAttentionLog.find({
      dieticianId,
      flagDate: todayFlag,
      patientId: { $in: needAttentionIds },
    }).lean();

    const acknowledgedToday = new Set();
    todayLogs.forEach((log) => {
      if (log.acknowledged) acknowledgedToday.add(log.patientId.toString());
    });

    // Split: present = not acknowledged, acknowledged go to history
    const presentIds = needAttentionIds.filter((id) => !acknowledgedToday.has(id.toString()));
    const acknowledgedIds = needAttentionIds.filter((id) => acknowledgedToday.has(id.toString()));

    // History = acknowledged today + patients flagged in last 30 days not in current list
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    thirtyDaysAgo.setHours(0, 0, 0, 0);

    const currentSet = new Set(needAttentionIds.map((id) => id.toString()));

    const historyLogs = await NeedAttentionLog.find({
      dieticianId,
      flagDate: { $gte: thirtyDaysAgo, $lt: todayFlag },
    })
      .sort({ flagDate: -1 })
      .lean();

    // Deduplicate: keep only the most recent flag per patient
    const seenHistory = new Set();
    const historyPatientIds = [];
    const historyDates = {};

    // First add today's acknowledged patients to history
    acknowledgedIds.forEach((pid) => {
      const pidStr = pid.toString();
      seenHistory.add(pidStr);
      historyPatientIds.push(pidStr);
      historyDates[pidStr] = todayFlag;
    });

    // Then add older history (not in current set and not already seen)
    historyLogs.forEach((log) => {
      const pid = log.patientId.toString();
      if (!currentSet.has(pid) && !seenHistory.has(pid)) {
        seenHistory.add(pid);
        historyPatientIds.push(pid);
        historyDates[pid] = log.flagDate;
      }
    });

    // Add history patient IDs to allPids so we fetch their names
    historyPatientIds.forEach((pid) => allPids.add(pid));

    const patientUsers = allPids.size > 0
      ? await User.find({ _id: { $in: [...allPids] } })
        .select('_id profile.fullName')
        .lean()
      : [];

    const nameMap = {};
    patientUsers.forEach((u) => {
      nameMap[u._id.toString()] = u.profile?.fullName || 'Patient';
    });

    const toPatientList = (ids) =>
      ids.map((id) => ({
        patientId: id.toString(),
        patientName: nameMap[id.toString()] || 'Patient',
      }));

    return res.status(200).json({
      success: true,
      data: {
        messagesReceived,
        messagesReceivedPatients: toPatientList(messagesReceivedPatientIds),
        reviewLoggedData,
        reviewLoggedPatients: toPatientList(reviewLoggedPatientIds),
        closingClients,
        closingClientsPatients: toPatientList(closingPatientIds),
        didExtremelyWell,
        didExtremelyWellPatients: toPatientList(didExtremelyWellIds),
        needAttention: presentIds.length,
        needAttentionPatients: toPatientList(presentIds),
        needAttentionHistory: historyPatientIds.map((id) => ({
          patientId: id,
          patientName: nameMap[id] || 'Patient',
          flagDate: historyDates[id],
        })),
        totalRevenue,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @route   POST /api/dietician/need-attention/:patientId/acknowledge
 * @desc    Mark a need-attention patient as read/acknowledged for today
 */
exports.acknowledgeNeedAttention = async (req, res, next) => {
  try {
    const dieticianId = req.user._id;
    const { patientId } = req.params;

    const todayFlag = new Date();
    todayFlag.setHours(0, 0, 0, 0);

    await NeedAttentionLog.findOneAndUpdate(
      { dieticianId, patientId, flagDate: todayFlag },
      { $set: { acknowledged: true } },
      { upsert: true, new: true }
    );

    return res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};

/**
 * @route   GET /api/dietician/performance-trends
 * @desc    Weekly patient count and revenue for the last 12 weeks
 */
exports.getPerformanceTrends = async (req, res, next) => {
  try {
    const dieticianId = req.user._id;
    const weeks = 12;

    // Build week boundaries (Sun–Sat) for the last 12 weeks
    const now = new Date();
    const currentWeekStart = new Date(now);
    currentWeekStart.setDate(now.getDate() - now.getDay());
    currentWeekStart.setHours(0, 0, 0, 0);

    const weekStarts = [];
    for (let i = weeks - 1; i >= 0; i--) {
      const ws = new Date(currentWeekStart);
      ws.setDate(ws.getDate() - i * 7);
      weekStarts.push(ws);
    }

    const rangeStart = weekStarts[0];

    // Get all diet plan requests for this dietician created in range
    const requests = await DietPlanRequest.find({
      dieticianId,
      createdAt: { $gte: rangeStart },
    })
      .select('patient createdAt _id')
      .lean();

    const requestIds = requests.map((r) => r._id);

    // Get approved payments in range
    const payments =
      requestIds.length > 0
        ? await ManualPaymentProof.find({
          request: { $in: requestIds },
          status: 'Approved',
          createdAt: { $gte: rangeStart },
        })
          .select('amountReceived createdAt')
          .lean()
        : [];

    // Bucket into weeks
    const patientWeekly = new Array(weeks).fill(0);
    const revenueWeekly = new Array(weeks).fill(0);

    for (const req of requests) {
      const idx = _weekIndex(req.createdAt, weekStarts);
      if (idx >= 0) patientWeekly[idx]++;
    }

    for (const pay of payments) {
      const idx = _weekIndex(pay.createdAt, weekStarts);
      if (idx >= 0) revenueWeekly[idx] += pay.amountReceived || 0;
    }

    // Cumulative totals up to range start (for overall numbers)
    const allRequests = await DietPlanRequest.countDocuments({ dieticianId });
    const allRevenueAgg = await ManualPaymentProof.aggregate([
      {
        $match: {
          request: {
            $in: (
              await DietPlanRequest.find({ dieticianId }).select('_id').lean()
            ).map((r) => r._id),
          },
          status: 'Approved',
        },
      },
      { $group: { _id: null, total: { $sum: '$amountReceived' } } },
    ]);
    const allRevenue = allRevenueAgg[0]?.total || 0;

    // Week-over-week change % (last vs second-to-last week)
    const prevPatients = patientWeekly[weeks - 2] || 0;
    const currPatients = patientWeekly[weeks - 1] || 0;
    const patientsChange =
      prevPatients > 0
        ? ((currPatients - prevPatients) / prevPatients) * 100
        : 0;

    const prevRevenue = revenueWeekly[weeks - 2] || 0;
    const currRevenue = revenueWeekly[weeks - 1] || 0;
    const revenueChange =
      prevRevenue > 0
        ? ((currRevenue - prevRevenue) / prevRevenue) * 100
        : 0;

    return res.status(200).json({
      success: true,
      data: {
        totalPatients: allRequests,
        totalRevenue: allRevenue,
        patientsChangePercent: Math.round(patientsChange * 10) / 10,
        revenueChangePercent: Math.round(revenueChange * 10) / 10,
        patientWeekly,
        revenueWeekly,
      },
    });
  } catch (error) {
    next(error);
  }
};

function _weekIndex(date, weekStarts) {
  const d = new Date(date);
  for (let i = weekStarts.length - 1; i >= 0; i--) {
    if (d >= weekStarts[i]) return i;
  }
  return -1;
}
