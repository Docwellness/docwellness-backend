/**
 * Read-only plan dates for one patient (openspec admin-plan-dates-timeline).
 * Only `find` reads: no save, no update, and no audit entry for viewing.
 */
const { User, DietPlan, DietPlanRequest, Goal } = require('../../models');
const AdminAuditLog = require('../../models/AdminAuditLog');
const { loadPatientPauses } = require('../../utils/patientPauseGuard');
const { buildPlanDates } = require('../../utils/adminPlanDates');
const { can } = require('../../utils/adminPermissions');

// GET /api/admin/users/:id/plan-dates
exports.getPlanDates = async (req, res, next) => {
  try {
    const { id } = req.params;
    // A malformed id never gets here: router.param('id') in routes/admin.js answers 400.
    const patient = await User.findOne({ _id: id, role: 'patient' }).select('_id').lean();
    if (!patient) return res.status(404).json({ success: false, message: 'Patient not found' });

    const [plans, requests, goals, extensionEntries, unionPauses] = await Promise.all([
      DietPlan.find({ patientId: patient._id })
        .limit(50)
        .select('request cycleNumber status activationDate weekSchedule pauses')
        .lean(),
      DietPlanRequest.find({ patient: patient._id })
        .sort({ createdAt: -1 })
        .limit(20)
        .select('status createdAt subscriptionStartDate subscriptionExpiresAt hasActivePlan')
        .lean(),
      // No title, metric or target fields: dates and statuses only.
      Goal.find({ patientId: patient._id })
        .sort({ createdAt: -1 })
        .limit(20)
        .select('status startDate endDate dietPlanId')
        .lean(),
      AdminAuditLog.find({
        action: 'user.extend_subscription',
        targetType: 'user',
        targetId: String(patient._id),
        outcome: { $in: ['success', 'failed'] },
      })
        .sort({ createdAt: -1 })
        .limit(100)
        .select('outcome createdAt actorEmail before after reason requestId')
        .lean()
        // Newest 100 are kept; the builder lists them oldest first.
        .then((rows) => rows.reverse()),
      loadPatientPauses(patient._id),
    ]);

    const data = buildPlanDates({
      plans,
      requests,
      goals,
      extensionEntries,
      unionPauses,
      now: new Date(),
      canViewAudit: can(req.admin?.permissions, 'audit', 'view'),
    });
    res.json({ success: true, data: { generatedFor: String(patient._id), ...data } });
  } catch (err) {
    next(err);
  }
};
