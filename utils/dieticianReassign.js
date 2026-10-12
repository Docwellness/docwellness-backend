const mongoose = require('mongoose');
const { DietPlanRequest, DietPlan, ExercisePlan, Goal, FirstConsultation, Conversation, CustomFoodRequest } = require('../models');

const oid = (v) => new mongoose.Types.ObjectId(String(v));

/**
 * Moves a patient's working relationship from one dietician to another
 * (openspec: admin-dietician-management, "Reassign clients").
 *
 * Moves the records the new dietician needs to work with the patient: the
 * diet plan requests, diet plans, exercise plans, goals, first consultation,
 * open custom-food requests and the chat conversation. History that is only
 * ever read (progress entries, reminders, per-day flags) stays as it was.
 * The recipes a plan uses stay owned by the original dietician.
 *
 * With `dryRun` nothing changes and the counts are returned.
 */
async function reassignPatients({ patientIds, fromId, toId, dryRun = false }) {
  const patients = patientIds.map(oid);
  const from = oid(fromId);
  const to = oid(toId);

  const plans = [
    ['dietPlanRequests', DietPlanRequest, { patient: { $in: patients }, dieticianId: from }, { dieticianId: to, needsReassignment: false }],
    ['dietPlans', DietPlan, { patientId: { $in: patients }, dieticianId: from }, { dieticianId: to }],
    ['exercisePlans', ExercisePlan, { patientId: { $in: patients }, dieticianId: from }, { dieticianId: to }],
    ['goals', Goal, { patientId: { $in: patients }, dieticianId: from }, { dieticianId: to }],
    ['firstConsultations', FirstConsultation, { patient: { $in: patients }, dietician: from }, { dietician: to }],
    [
      'customFoodRequests',
      CustomFoodRequest,
      { patientId: { $in: patients }, dieticianId: from, status: { $in: ['Pending', 'pending'] } },
      { dieticianId: to },
    ],
  ];

  const counts = {};
  for (const [key, Model, filter, set] of plans) {
    if (dryRun) counts[key] = await Model.countDocuments(filter);
    else counts[key] = (await Model.updateMany(filter, { $set: set })).modifiedCount;
  }

  // Chat: swap the old dietician for the new one in the patient's conversation.
  const convFilter = { $and: [{ 'participants.userId': from }, { 'participants.userId': { $in: patients } }] };
  if (dryRun) counts.conversations = await Conversation.countDocuments(convFilter);
  else {
    counts.conversations = (
      await Conversation.updateMany(convFilter, { $set: { 'participants.$[p].userId': to } }, { arrayFilters: [{ 'p.userId': from }] })
    ).modifiedCount;
  }
  return counts;
}

module.exports = { reassignPatients };
