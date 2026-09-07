/**
 * Single source of truth for "what data belongs to a patient" and how to
 * delete it. Imported by:
 *   - controllers/dietician/patientController.js  (deletePatientData)
 *   - scripts/delete-all-patients.js              (prod patient wipe)
 *
 * The cascade used to live inline in the dietician controller and was
 * copy-pasted (with drift) into half a dozen reset scripts - some missing
 * ExerciseLog / the Goal->Milestone chain / the DayPlan->PlanItem chain,
 * some using wrong collection names (`chatmessages` vs `chats`). Keep every
 * per-collection filter here and nowhere else.
 *
 * No MongoDB transactions: this codebase uses none, prod Mongo is a
 * standalone instance (no replica set -> no transactions), and the test
 * harness is single-node mongodb-memory-server. Deletes are therefore
 * best-effort `Promise.all(deleteMany)`; every operation is id-scoped and
 * idempotent, so a partial failure is safe to re-run.
 *
 * NOTE: the category keys + labels below are mirrored in the dietician app
 * (docwellness-dietician .../views/delete_patient_data_sheet.dart). Review
 * both together when adding a category.
 */

const {
  User,
  DietPlan,
  DietPlanRequest,
  FirstConsultation,
  ManualPaymentProof,
  Progress,
  MealLog,
  WaterLog,
  ExercisePlan,
  ExerciseLog,
  Notification,
  Chat,
  Conversation,
  CustomFoodRequest,
  JourneyImage,
  NeedAttentionLog,
  Review,
  Nudge,
  Goal,
  Milestone,
  MilestoneTask,
  CheckIn,
  DayPlan,
  MealSlotPlan,
  PlanItem,
  SupplementItem,
} = require('../models');
const { getSupabaseAdmin } = require('./supabaseAuth');

/**
 * Ordered list of deletable data categories. `key` is what the API/UI
 * sends; `label` is human copy; `accountOnly` categories can only be
 * removed as part of a full account deletion (see below).
 */
const PATIENT_DATA_CATEGORIES = [
  { key: 'dietPlan', label: 'Diet plans & meal schedules' },
  { key: 'mealLog', label: 'Meal logs' },
  { key: 'waterLog', label: 'Water logs' },
  { key: 'customFoodRequest', label: 'Custom food requests' },
  { key: 'exercisePlan', label: 'Exercise plans' },
  { key: 'exerciseLog', label: 'Exercise logs' },
  { key: 'progress', label: 'Progress entries & body photos' },
  { key: 'journeyImage', label: 'Before / after journey photos' },
  { key: 'goal', label: 'Goals, milestones & check-ins' },
  { key: 'firstConsultation', label: 'First consultation & lab reports' },
  { key: 'chat', label: 'Chat messages & conversations' },
  { key: 'notification', label: 'Notifications' },
  { key: 'manualPaymentProof', label: 'Payment proofs' },
  {
    key: 'dietPlanRequest',
    label: 'Membership / subscription record',
    accountOnly: true,
  },
  { key: 'nudge', label: 'Nudges sent to the patient' },
  { key: 'needAttentionLog', label: 'Need-attention flags' },
  { key: 'review', label: "Patient's review of the dietician" },
];

const CATEGORY_KEYS = PATIENT_DATA_CATEGORIES.map((c) => c.key);
const ACCOUNT_ONLY_KEYS = PATIENT_DATA_CATEGORIES.filter((c) => c.accountOnly).map((c) => c.key);

/**
 * `status.*` fields on the User document that stop making sense once a
 * given category's data is gone. Only applied for a partial delete - a
 * full erase drops the whole User document anyway.
 */
const CATEGORY_USER_STATUS_RESET = {
  dietPlan: { 'status.activeDietPlanId': null, 'status.pendingDietPlanId': null },
  firstConsultation: { 'status.firstConsultationId': null, 'status.patientConsented': false },
  dietPlanRequest: { 'status.requestId': null, 'status.requestStatus': null },
};

// Simple one-collection-one-field categories: filter(ids) -> mongoose query.
const DIRECT_CATEGORIES = {
  mealLog: { coll: 'meallogs', Model: MealLog, filter: (ids) => ({ patientId: { $in: ids } }) },
  waterLog: { coll: 'waterlogs', Model: WaterLog, filter: (ids) => ({ patientId: { $in: ids } }) },
  customFoodRequest: {
    coll: 'customfoodrequests',
    Model: CustomFoodRequest,
    filter: (ids) => ({ patientId: { $in: ids } }),
  },
  exercisePlan: {
    coll: 'exerciseplans',
    Model: ExercisePlan,
    filter: (ids) => ({ patientId: { $in: ids } }),
  },
  exerciseLog: {
    coll: 'exerciselogs',
    Model: ExerciseLog,
    filter: (ids) => ({ patientId: { $in: ids } }),
  },
  progress: { coll: 'progresses', Model: Progress, filter: (ids) => ({ patientId: { $in: ids } }) },
  journeyImage: {
    coll: 'journeyimages',
    Model: JourneyImage,
    filter: (ids) => ({ patientId: { $in: ids } }),
  },
  firstConsultation: {
    coll: 'firstconsultations',
    Model: FirstConsultation,
    filter: (ids) => ({ patient: { $in: ids } }),
  },
  notification: {
    coll: 'notifications',
    Model: Notification,
    filter: (ids) => ({ userId: { $in: ids } }),
  },
  manualPaymentProof: {
    coll: 'manualpaymentproofs',
    Model: ManualPaymentProof,
    filter: (ids) => ({ patient: { $in: ids } }),
  },
  dietPlanRequest: {
    coll: 'dietplanrequests',
    Model: DietPlanRequest,
    filter: (ids) => ({ patient: { $in: ids } }),
  },
  nudge: { coll: 'nudges', Model: Nudge, filter: (ids) => ({ patientId: { $in: ids } }) },
  needAttentionLog: {
    coll: 'needattentionlogs',
    Model: NeedAttentionLog,
    filter: (ids) => ({ patientId: { $in: ids } }),
  },
  review: { coll: 'reviews', Model: Review, filter: (ids) => ({ patientId: { $in: ids } }) },
};

const idList = (docs) => docs.map((d) => d._id);

/**
 * Build the list of `{ coll, Model, filter }` delete specs for one
 * category. For the two parent->child chains (diet plan tree, goal tree)
 * the child filters are resolved from ids actually present, mirroring
 * dietPlanController.deleteDraftDietPlanTree and
 * scripts/cleanup-prod-test-users.js.
 */
async function specsForCategory(key, ids) {
  if (DIRECT_CATEGORIES[key]) {
    const d = DIRECT_CATEGORIES[key];
    return [{ coll: d.coll, Model: d.Model, filter: d.filter(ids) }];
  }

  if (key === 'chat') {
    return [
      {
        coll: 'chats',
        Model: Chat,
        filter: { $or: [{ senderId: { $in: ids } }, { receiverId: { $in: ids } }] },
      },
      {
        coll: 'conversations',
        Model: Conversation,
        filter: { 'participants.userId': { $in: ids } },
      },
    ];
  }

  if (key === 'dietPlan') {
    const dietPlanIds = idList(await DietPlan.find({ patientId: { $in: ids } }).select('_id').lean());
    const dayPlanIds = idList(
      await DayPlan.find({
        $or: [{ patientId: { $in: ids } }, { dietPlanId: { $in: dietPlanIds } }],
      })
        .select('_id')
        .lean()
    );
    const mealSlotIds = dayPlanIds.length
      ? idList(await MealSlotPlan.find({ dayPlanId: { $in: dayPlanIds } }).select('_id').lean())
      : [];
    return [
      { coll: 'planitems', Model: PlanItem, filter: { mealSlotId: { $in: mealSlotIds } } },
      {
        coll: 'supplementitems',
        Model: SupplementItem,
        filter: { mealSlotId: { $in: mealSlotIds } },
      },
      { coll: 'mealslotplans', Model: MealSlotPlan, filter: { dayPlanId: { $in: dayPlanIds } } },
      { coll: 'dayplans', Model: DayPlan, filter: { _id: { $in: dayPlanIds } } },
      { coll: 'dietplans', Model: DietPlan, filter: { patientId: { $in: ids } } },
    ];
  }

  if (key === 'goal') {
    const goalIds = idList(await Goal.find({ patientId: { $in: ids } }).select('_id').lean());
    const milestoneIds = goalIds.length
      ? idList(await Milestone.find({ goalId: { $in: goalIds } }).select('_id').lean())
      : [];
    return [
      {
        coll: 'milestonetasks',
        Model: MilestoneTask,
        filter: { milestoneId: { $in: milestoneIds } },
      },
      { coll: 'milestones', Model: Milestone, filter: { goalId: { $in: goalIds } } },
      { coll: 'checkins', Model: CheckIn, filter: { patientId: { $in: ids } } },
      { coll: 'goals', Model: Goal, filter: { patientId: { $in: ids } } },
    ];
  }

  throw new Error(`Unknown patient-data category: ${key}`);
}

function normalizeIds(patientIds) {
  const ids = (Array.isArray(patientIds) ? patientIds : [patientIds]).filter(Boolean);
  if (ids.length === 0) throw new Error('patientDataDeletion: no patient ids given');
  return ids;
}

function validateCategoryKeys(categoryKeys) {
  const unknown = categoryKeys.filter((k) => !CATEGORY_KEYS.includes(k));
  if (unknown.length) throw new Error(`Unknown data category: ${unknown.join(', ')}`);
}

/**
 * Count what a delete of `categoryKeys` would remove for `patientIds`,
 * without touching anything. `{ [collection]: count }`.
 */
async function countPatientData(patientIds, categoryKeys = CATEGORY_KEYS) {
  const ids = normalizeIds(patientIds);
  validateCategoryKeys(categoryKeys);
  const totals = {};
  for (const key of categoryKeys) {
    const specs = await specsForCategory(key, ids);
    for (const spec of specs) {
      const n = await spec.Model.countDocuments(spec.filter);
      totals[spec.coll] = (totals[spec.coll] || 0) + n;
    }
  }
  return totals;
}

/**
 * Delete the selected `categoryKeys` for `patientIds`. Returns
 * `{ [collection]: deletedCount }`. Clears the matching `status.*` fields
 * on the affected User docs (partial-delete housekeeping).
 *
 * @param {Object}  opts
 * @param {boolean} opts.execute  when false, counts only (nothing deleted)
 */
async function deletePatientData(patientIds, categoryKeys = CATEGORY_KEYS, { execute = false } = {}) {
  const ids = normalizeIds(patientIds);
  validateCategoryKeys(categoryKeys);

  const deleted = {};
  for (const key of categoryKeys) {
    const specs = await specsForCategory(key, ids);
    for (const spec of specs) {
      if (execute) {
        const res = await spec.Model.deleteMany(spec.filter);
        deleted[spec.coll] = (deleted[spec.coll] || 0) + (res.deletedCount || 0);
      } else {
        deleted[spec.coll] = (deleted[spec.coll] || 0) + (await spec.Model.countDocuments(spec.filter));
      }
    }
  }

  if (execute) {
    const statusReset = {};
    for (const key of categoryKeys) {
      Object.assign(statusReset, CATEGORY_USER_STATUS_RESET[key] || {});
    }
    if (Object.keys(statusReset).length) {
      await User.updateMany({ _id: { $in: ids } }, { $set: statusReset });
    }
  }

  return deleted;
}

/**
 * Full erase of one patient: every category, then the User document, then
 * the Supabase auth identity (best-effort - a failure there only logs).
 * Returns `{ ...collectionCounts, users }`.
 */
async function erasePatientCompletely(patient, { deleteSupabase = true } = {}) {
  const counts = await deletePatientData([patient._id], CATEGORY_KEYS, { execute: true });
  const res = await User.deleteOne({ _id: patient._id });
  counts.users = res.deletedCount || 0;

  if (deleteSupabase && patient.supabaseUserId) {
    await getSupabaseAdmin()
      .auth.admin.deleteUser(patient.supabaseUserId)
      .catch((err) => {
        console.error(
          `Failed to delete Supabase user ${patient.supabaseUserId} during patient erase:`,
          err.message
        );
      });
  }

  return counts;
}

module.exports = {
  PATIENT_DATA_CATEGORIES,
  CATEGORY_KEYS,
  ACCOUNT_ONLY_KEYS,
  countPatientData,
  deletePatientData,
  erasePatientCompletely,
};
