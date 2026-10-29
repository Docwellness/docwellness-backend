const mongoose = require('mongoose');

/**
 * One row in most collections the deletion cascade covers, for `patient`.
 * Returns the created diet plan (handy for status assertions). Not seeded
 * here: exercisePlan, journeyImage, needAttentionLog and dietPlanRequest
 * (callers add what they need).
 */
async function seedPatientData(patient, dietician) {
  const {
    MealLog,
    WaterLog,
    Progress,
    ExerciseLog,
    Notification,
    DietPlan,
    DayPlan,
    MealSlotPlan,
    PlanItem,
    Goal,
    Milestone,
    MilestoneTask,
    CheckIn,
    Nudge,
    Review,
    FirstConsultation,
    ManualPaymentProof,
    Chat,
    Conversation,
    CustomFoodRequest,
  } = require('../../models');

  await MealLog.create({ patientId: patient._id, date: new Date(), dayKey: '2026-09-01', meals: [] });
  await WaterLog.create({ patientId: patient._id, date: '2026-09-01' });
  await Progress.create({ patientId: patient._id, date: new Date(), weight: 70 });
  await ExerciseLog.create({ patientId: patient._id, date: new Date(), exercises: [] });
  await Notification.create({ userId: patient._id, title: 'Hi', message: 'There' });
  await CustomFoodRequest.create({
    patientId: patient._id,
    dieticianId: dietician._id,
    date: new Date(),
    servingTime: 'Breakfast',
    foodName: 'Poha',
  });

  const plan = await DietPlan.create({
    patientId: patient._id,
    dieticianId: dietician._id,
    status: 'Active',
    startDate: new Date(),
  });
  const day = await DayPlan.create({
    dietPlanId: plan._id,
    patientId: patient._id,
    week: 1,
    dayGroup: 'Monday',
  });
  const slot = await MealSlotPlan.create({ dayPlanId: day._id, servingTime: 'Breakfast' });
  await PlanItem.create({ mealSlotId: slot._id, recipeVersionId: new mongoose.Types.ObjectId() });

  const goal = await Goal.create({
    patientId: patient._id,
    dieticianId: dietician._id,
    title: 'Lose weight',
    targetValue: 64,
    startDate: new Date(),
    endDate: new Date(Date.now() + 7 * 864e5),
  });
  const milestone = await Milestone.create({
    goalId: goal._id,
    type: 'weekly',
    title: 'Week 1',
    date: new Date(),
    sortOrder: 0,
  });
  const task = await MilestoneTask.create({ milestoneId: milestone._id, title: 'Log every meal' });
  await CheckIn.create({ patientId: patient._id, taskId: task._id, milestoneId: milestone._id });

  await Nudge.create({
    patientId: patient._id,
    dieticianId: dietician._id,
    message: 'Keep going',
  });
  await Review.create({ dieticianId: dietician._id, patientId: patient._id, rating: 5 });
  await FirstConsultation.create({ patient: patient._id, dietician: dietician._id });
  const conversation = await Conversation.create({
    participants: [{ userId: patient._id }, { userId: dietician._id }],
  });
  await Chat.create({
    conversationId: conversation._id,
    senderId: patient._id,
    receiverId: dietician._id,
    message: 'Hello',
  });
  await ManualPaymentProof.create({
    patient: patient._id,
    request: new mongoose.Types.ObjectId(),
    amountReceived: 100,
    amountPending: 0,
  });

  return plan;
}

module.exports = { seedPatientData };
