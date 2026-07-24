/**
 * Dashboard aggregation endpoints - AI_EXECUTION_PLAN.md Phase 5 (P5-02/P5-03).
 *
 * Goal: let each app's home screen make ONE call instead of the ~6-8
 * separate calls it makes today (profile, request status, today's meal
 * stats, water, progress, doctor profile, unread chat, unread
 * notifications - see docwellness-user's HomeController.refreshAllData()
 * for the exact list this mirrors). Existing individual endpoints are
 * untouched - this is purely additive, new v1-only routes.
 *
 * Response caching is optional (see utils/cache.js) - a short TTL so a
 * dashboard load right after a mutation (e.g. just logged a meal) isn't
 * stuck showing 20s-stale data, while still absorbing rapid repeat loads
 * (e.g. pull-to-refresh spam) when REDIS_URL is configured.
 */

const {
  User,
  DietPlanRequest,
  DietPlan,
  MealLog,
  Progress,
  Conversation,
} = require('../models');
const WaterLog = require('../models/WaterLog');
const FirstConsultation = require('../models/FirstConsultation');
const ConversationV1 = require('../chat/models/ConversationV1');
const Notification = require('../models/Notification');
const config = require('../config/environment');
const { getOrSetJSON } = require('../utils/cache');

const DASHBOARD_CACHE_TTL_SECONDS = 20;

function todayRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Merges legacy Conversation + ConversationV1 unread counts between two
 * users the same way controllers/dietician/dashboardController.js and
 * controllers/chatController.js already do (V1 takes priority when both
 * exist) - kept as a local helper here rather than a shared export since
 * the two call sites (single-patient vs all-of-a-dietician's-patients)
 * need different shapes.
 */
async function getUnreadCountBetween(userId, otherUserId) {
  const [legacyConv, v1Conv] = await Promise.all([
    Conversation.findOne({
      $and: [{ 'participants.userId': userId }, { 'participants.userId': otherUserId }],
    }).lean(),
    ConversationV1.findOne({
      $and: [{ 'participants.userId': userId }, { 'participants.userId': otherUserId }],
    }).lean(),
  ]);

  if (v1Conv) {
    const me = v1Conv.participants.find((p) => String(p.userId) === String(userId));
    return me?.unreadCount || 0;
  }
  if (legacyConv) {
    const me = legacyConv.participants.find((p) => String(p.userId) === String(userId));
    return me?.unreadCount || 0;
  }
  return 0;
}

/**
 * @route   GET /api/v1/patient/dashboard
 * @desc    Aggregated home-screen data for a patient in a single call
 */
exports.getPatientDashboard = async (req, res, next) => {
  try {
    const patientId = req.user._id;

    const data = await getOrSetJSON(`dashboard:patient:${patientId}`, DASHBOARD_CACHE_TTL_SECONDS, async () => {
      const { start: todayStart, end: todayEnd } = todayRange();
      const dieticianId = config.defaultDieticianId;

      const [
        user,
        latestRequest,
        activePlan,
        todayLogs,
        waterLog,
        latestProgress,
        doctor,
        unreadNotificationCount,
      ] = await Promise.all([
        User.findById(patientId).select('email profile healthProfile').lean(),
        DietPlanRequest.findOne({ patient: patientId }).sort({ createdAt: -1 }).lean(),
        DietPlan.findOne({ patientId, status: 'Active' })
          .select('name totalCalories calorieStrategy startDate endDate')
          .lean(),
        MealLog.find({ patientId, date: { $gte: todayStart, $lte: todayEnd } })
          .select('totalCalories meals')
          .lean(),
        WaterLog.findOne({ patientId, date: todayDateString() }).lean(),
        Progress.findOne({ patientId }).sort({ date: -1 }).lean(),
        dieticianId
          ? User.findById(dieticianId).select('profile.fullName profile.profileImage profile.gender dieticianProfile').lean()
          : null,
        Notification.countDocuments({ userId: patientId, isRead: false }),
      ]);

      const caloriesConsumedToday = todayLogs.reduce((sum, log) => sum + (log.totalCalories || 0), 0);
      const calorieBudget = activePlan?.calorieStrategy?.calorieBudget || activePlan?.totalCalories || 0;

      const unreadChatCount = dieticianId ? await getUnreadCountBetween(patientId, dieticianId) : 0;

      return {
        profile: user
          ? { email: user.email, ...user.profile, healthProfile: user.healthProfile }
          : null,
        subscription: latestRequest
          ? {
            membershipPlan: latestRequest.membershipPlan,
            hasActivePlan: latestRequest.hasActivePlan,
            subscriptionStartDate: latestRequest.subscriptionStartDate,
            subscriptionExpiresAt: latestRequest.subscriptionExpiresAt,
          }
          : null,
        requestStatus: latestRequest
          ? { requestId: latestRequest._id, status: latestRequest.status }
          : null,
        todayMealSummary: {
          caloriesConsumed: caloriesConsumedToday,
          calorieBudget,
          mealsLogged: todayLogs.reduce((sum, log) => sum + (log.meals?.length || 0), 0),
        },
        water: {
          totalAmount: waterLog?.totalAmount || 0,
          goal: waterLog?.goal || 2500,
        },
        progress: latestProgress
          ? {
            date: latestProgress.date,
            weight: latestProgress.weight,
            bmi: latestProgress.bmi,
          }
          : null,
        doctor: doctor
          ? {
            fullName: doctor.profile?.fullName || '',
            profileImage: doctor.profile?.profileImage || '',
            specialization: doctor.dieticianProfile?.specialization || '',
          }
          : null,
        unreadChatCount,
        unreadNotificationCount,
      };
    });

    return res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/**
 * @route   GET /api/v1/dietician/dashboard
 * @desc    Aggregated home-screen data for the dietician in a single call.
 *          Reuses the same data sources as
 *          controllers/dietician/dashboardController.js's getDashboardStats
 *          (the existing /dashboard-stats endpoint, left untouched), but
 *          reshaped to this endpoint's own response contract.
 */
exports.getDieticianDashboard = async (req, res, next) => {
  try {
    const dieticianId = req.user._id;

    const data = await getOrSetJSON(`dashboard:dietician:${dieticianId}`, DASHBOARD_CACHE_TTL_SECONDS, async () => {
      const { start: todayStart, end: todayEnd } = todayRange();
      const yesterdayStart = new Date(todayStart);
      yesterdayStart.setDate(yesterdayStart.getDate() - 1);
      const yesterdayEnd = new Date(todayEnd);
      yesterdayEnd.setDate(yesterdayEnd.getDate() - 1);

      const [patientIds, pendingDietPlans, recentRequests] = await Promise.all([
        DietPlanRequest.distinct('patient', { dieticianId }),
        DietPlan.countDocuments({ dieticianId, status: 'Draft' }),
        DietPlanRequest.find({ dieticianId })
          .sort({ createdAt: -1 })
          .limit(5)
          .populate('patient', 'profile.fullName profile.profileImage')
          .lean(),
      ]);

      // recentMealLogs: most recent logs across this dietician's own patients
      // (MealLog has no dieticianId field, so scope via patientIds first).
      const recentMealLogs = patientIds.length
        ? await MealLog.find({ patientId: { $in: patientIds } })
          .sort({ createdAt: -1 })
          .limit(5)
          .populate('patientId', 'profile.fullName')
          .select('patientId date totalCalories')
          .lean()
        : [];

      // Unread messages: total unread count summed across every conversation
      // (not just count of patients with unread, unlike dashboard-stats'
      // messagesReceived) - mirrors P5-04's unread-count semantics.
      const [legacyConversations, v1Conversations] = await Promise.all([
        Conversation.find({ 'participants.userId': dieticianId }).lean(),
        ConversationV1.find({ 'participants.userId': dieticianId }).lean(),
      ]);
      const v1UnreadByOtherUser = {};
      v1Conversations.forEach((conv) => {
        const me = conv.participants.find((p) => String(p.userId) === String(dieticianId));
        const other = conv.participants.find((p) => String(p.userId) !== String(dieticianId));
        if (me && other) v1UnreadByOtherUser[String(other.userId)] = me.unreadCount || 0;
      });
      let unreadMessages = 0;
      const countedOtherUsers = new Set();
      legacyConversations.forEach((conv) => {
        const me = conv.participants.find((p) => String(p.userId) === String(dieticianId));
        const other = conv.participants.find((p) => String(p.userId) !== String(dieticianId));
        if (!me || !other) return;
        const otherId = String(other.userId);
        const unread = v1UnreadByOtherUser[otherId] !== undefined ? v1UnreadByOtherUser[otherId] : (me.unreadCount || 0);
        unreadMessages += unread;
        countedOtherUsers.add(otherId);
      });
      v1Conversations.forEach((conv) => {
        const me = conv.participants.find((p) => String(p.userId) === String(dieticianId));
        const other = conv.participants.find((p) => String(p.userId) !== String(dieticianId));
        if (!me || !other) return;
        const otherId = String(other.userId);
        if (countedOtherUsers.has(otherId)) return;
        unreadMessages += me.unreadCount || 0;
      });

      // needAttention: patients whose active-plan calorie adherence
      // yesterday was poor (<50% or >150% of budget) or who didn't log at
      // all - same thresholds as dashboardController.getDashboardStats.
      const activePlans = await DietPlan.find({ dieticianId, status: 'Active' })
        .select('patientId totalCalories calorieStrategy')
        .lean();
      const activePlanMap = {};
      activePlans.forEach((plan) => {
        const budget = plan.calorieStrategy?.calorieBudget || plan.totalCalories || 0;
        if (budget > 0) activePlanMap[plan.patientId.toString()] = budget;
      });
      const activePatientIds = Object.keys(activePlanMap);
      let needAttention = 0;
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
          const consumed = loggedMap[pid];
          if (consumed === undefined) {
            needAttention++;
            return;
          }
          const ratio = consumed / activePlanMap[pid];
          if (ratio < 0.5 || ratio > 1.5) needAttention++;
        });
      }

      // todayConsultations: first-consultation records touched today for
      // this dietician's patients (created or updated) - a reasonable proxy
      // for "consultations handled today" given there's no separate
      // appointment/scheduling model in this codebase.
      const todayConsultations = await FirstConsultation.find({
        dietician: dieticianId,
        updatedAt: { $gte: todayStart, $lte: todayEnd },
      })
        .populate('patient', 'profile.fullName profile.profileImage')
        .select('patient updatedAt')
        .lean();

      return {
        totalPatients: patientIds.length,
        needAttention,
        pendingDietPlans,
        unreadMessages,
        recentPatients: recentRequests.map((r) => ({
          patientId: r.patient?._id || null,
          patientName: r.patient?.profile?.fullName || null,
          profileImage: r.patient?.profile?.profileImage || null,
          status: r.status,
          createdAt: r.createdAt,
        })),
        recentMealLogs: recentMealLogs.map((log) => ({
          patientId: log.patientId?._id || log.patientId,
          patientName: log.patientId?.profile?.fullName || null,
          date: log.date,
          totalCalories: log.totalCalories || 0,
        })),
        todayConsultations: todayConsultations.map((c) => ({
          patientId: c.patient?._id || null,
          patientName: c.patient?.profile?.fullName || null,
          profileImage: c.patient?.profile?.profileImage || null,
          updatedAt: c.updatedAt,
        })),
      };
    });

    return res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};
