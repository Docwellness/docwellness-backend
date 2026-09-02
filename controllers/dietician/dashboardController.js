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

    // --- Date boundaries (computed once) ---
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const yesterdayStart = new Date();
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    yesterdayStart.setHours(0, 0, 0, 0);
    const yesterdayEnd = new Date();
    yesterdayEnd.setDate(yesterdayEnd.getDate() - 1);
    yesterdayEnd.setHours(23, 59, 59, 999);

    const nowTs = new Date();
    const sevenDaysFromNow = new Date();
    sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);

    const todayFlag = new Date();
    todayFlag.setHours(0, 0, 0, 0);
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    thirtyDaysAgo.setHours(0, 0, 0, 0);

    // --- Tier 1: every read keyed only on dieticianId, issued in parallel.
    // (Cross-app performance optimization, Phase 2: was ~5 sequential round
    // trips; the NeedAttentionLog 30-day history read is independent of the
    // flagged-patient set and moves up here too.)
    const [
      conversationsV1,
      legacyConversations,
      dieticianRequests,
      closingPlans,
      activePlans,
      historyLogs,
    ] = await Promise.all([
      ConversationV1.find({ 'participants.userId': dieticianId }).lean(),
      Conversation.find({ 'participants.userId': dieticianId })
        .populate('participants.userId', '_id')
        .lean(),
      DietPlanRequest.find({ dieticianId }).select('_id patient').lean(),
      DietPlan.find({
        dieticianId,
        status: 'Active',
        endDate: { $lte: sevenDaysFromNow, $gte: nowTs },
      })
        .select('patientId')
        .lean(),
      DietPlan.find({ dieticianId, status: 'Active' })
        .select('patientId totalCalories calorieStrategy')
        .lean(),
      NeedAttentionLog.find({
        dieticianId,
        flagDate: { $gte: thirtyDaysAgo, $lt: todayFlag },
      })
        .sort({ flagDate: -1 })
        .lean(),
    ]);

    // 1. Messages Received — number of patients with unread messages.
    //    V1 unreadCount takes priority when the same patient exists in both.
    const v1UnreadByUser = {};
    conversationsV1.forEach((conv) => {
      const me = conv.participants.find((p) => p.userId.toString() === dieticianId.toString());
      const other = conv.participants.find((p) => p.userId.toString() !== dieticianId.toString());
      if (me && other) {
        v1UnreadByUser[other.userId.toString()] = me.unreadCount || 0;
      }
    });

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

    const messagesReceived = messagesReceivedPatientIds.length;

    // Id sets derived from Tier 1
    const patientIds = dieticianRequests.map((r) => r.patient);
    const requestIds = dieticianRequests.map((r) => r._id);
    const closingClients = closingPlans.length;
    const closingPatientIds = closingPlans.map((p) => p.patientId);

    // Active-plan calorie budgets (patientId -> budget)
    const activePlanMap = {};
    activePlans.forEach((plan) => {
      const budget = plan.calorieStrategy?.calorieBudget || plan.totalCalories || 0;
      if (budget > 0) {
        activePlanMap[plan.patientId.toString()] = budget;
      }
    });
    const activePatientIds = Object.keys(activePlanMap);

    // --- Tier 2: reads keyed on the Tier 1 id sets, issued in parallel. ---
    const [reviewLoggedPatientIds, revenueAgg, yesterdayLogs] = await Promise.all([
      // 2. Review Logged Data — this dietician's patients who logged a meal today
      MealLog.distinct('patientId', {
        patientId: { $in: patientIds },
        date: { $gte: todayStart, $lte: todayEnd },
      }),
      // Revenue = sum of amount actually received for approved manual proofs
      requestIds.length > 0
        ? ManualPaymentProof.aggregate([
            { $match: { request: { $in: requestIds }, status: 'Approved' } },
            { $group: { _id: null, totalRevenue: { $sum: '$amountReceived' } } },
          ])
        : Promise.resolve([]),
      // 4/5. Yesterday's meal logs for active-plan patients (calorie ratio buckets)
      activePatientIds.length > 0
        ? MealLog.find({
            patientId: { $in: activePatientIds },
            date: { $gte: yesterdayStart, $lte: yesterdayEnd },
          })
            .select('patientId totalCalories')
            .lean()
        : Promise.resolve([]),
    ]);

    const reviewLoggedData = reviewLoggedPatientIds.length;
    const totalRevenue = revenueAgg[0]?.totalRevenue || 0;

    // 4. Did extremely well / 5. Need attention — vs planned calories yesterday
    let didExtremelyWell = 0;
    let needAttention = 0;
    const didExtremelyWellIds = [];
    const needAttentionIds = [];

    if (activePatientIds.length > 0) {
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

      // Also count active-plan patients with NO log at all yesterday
      const patientsWithLogs = new Set(Object.keys(loggedMap));
      activePatientIds.forEach((pid) => {
        if (!patientsWithLogs.has(pid)) {
          needAttention++;
          needAttentionIds.push(pid);
        }
      });
    }

    // --- Tier 3: today's acknowledgement state for the flagged patients. ---
    // Reads only rows written by earlier calls today; a patient flagged for
    // the first time this call cannot yet be acknowledged, so the response is
    // identical whether or not this call's flags have been persisted (they're
    // written fire-and-forget after the response — see below).
    const todayLogs = needAttentionIds.length > 0
      ? await NeedAttentionLog.find({
          dieticianId,
          flagDate: todayFlag,
          patientId: { $in: needAttentionIds },
        }).lean()
      : [];

    const acknowledgedToday = new Set();
    todayLogs.forEach((log) => {
      if (log.acknowledged) acknowledgedToday.add(log.patientId.toString());
    });

    // Split: present = not acknowledged, acknowledged go to history
    const presentIds = needAttentionIds.filter((id) => !acknowledgedToday.has(id.toString()));
    const acknowledgedIds = needAttentionIds.filter((id) => acknowledgedToday.has(id.toString()));

    const currentSet = new Set(needAttentionIds.map((id) => id.toString()));

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

    // --- Tier 4: patient names for every id referenced in the response ---
    const allPids = new Set([
      ...messagesReceivedPatientIds.map((id) => id.toString()),
      ...reviewLoggedPatientIds.map((id) => id.toString()),
      ...closingPatientIds.map((id) => id.toString()),
      ...didExtremelyWellIds,
      ...needAttentionIds,
      ...historyPatientIds,
    ]);

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

    res.status(200).json({
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

    // Persist today's need-attention flags AFTER responding. This GET used to
    // be a writer: it ran this bulkWrite mid-handler and then read the rows
    // back. The read (todayLogs) only ever needs flags from *earlier* calls
    // today, so the response is byte-identical whether or not this call's
    // flags exist yet - which lets the write become fire-and-forget, off the
    // request's critical path. `$setOnInsert` keeps it idempotent per
    // (dietician, patient, day); the acknowledge endpoint and the next call's
    // history read are the only consumers.
    if (needAttentionIds.length > 0) {
      NeedAttentionLog.bulkWrite(
        needAttentionIds.map((pid) => ({
          updateOne: {
            filter: { dieticianId, patientId: pid, flagDate: todayFlag },
            update: { $setOnInsert: { dieticianId, patientId: pid, flagDate: todayFlag } },
            upsert: true,
          },
        })),
        { ordered: false }
      ).catch((err) => {
        console.error('[dashboardStats] need-attention flag write failed (non-fatal):', err.message);
      });
    }
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

    // Cross-app performance optimization, Phase 2: this used to issue the
    // same "this dietician's requests" query THREE times (an in-range find,
    // a countDocuments, and a find() nested inside an aggregate $match). Now
    // one query for all of this dietician's requests supplies the total
    // count, the in-range slice for the weekly buckets, and the id list for
    // the payment lookups; and one payments query supplies both the all-time
    // total and the in-range slice. (A dietician's total request count is
    // bounded - hundreds at most - so filtering the range slice in JS is
    // cheaper than a second round trip.)
    const allRequests = await DietPlanRequest.find({ dieticianId })
      .select('createdAt _id')
      .lean();

    const allRequestIds = allRequests.map((r) => r._id);
    const inRangeRequests = allRequests.filter((r) => r.createdAt >= rangeStart);

    const approvedPayments =
      allRequestIds.length > 0
        ? await ManualPaymentProof.find({
          request: { $in: allRequestIds },
          status: 'Approved',
        })
          .select('amountReceived createdAt')
          .lean()
        : [];

    // Bucket into weeks
    const patientWeekly = new Array(weeks).fill(0);
    const revenueWeekly = new Array(weeks).fill(0);

    for (const r of inRangeRequests) {
      const idx = _weekIndex(r.createdAt, weekStarts);
      if (idx >= 0) patientWeekly[idx]++;
    }

    let allRevenue = 0;
    for (const pay of approvedPayments) {
      allRevenue += pay.amountReceived || 0;
      if (pay.createdAt >= rangeStart) {
        const idx = _weekIndex(pay.createdAt, weekStarts);
        if (idx >= 0) revenueWeekly[idx] += pay.amountReceived || 0;
      }
    }

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
        totalPatients: allRequests.length,
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
