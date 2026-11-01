/**
 * A patient two plan cycles in: cycle 1 (Weeks 1-4) ended the day before cycle 2
 * (Weeks 5-8) started 6 days ago, so the Week 5 checkpoint falls on today.
 * Dates are UTC days relative to now, so the fixture never rots. The goal is
 * seeded the way production does it: from cycle 1, then extended by the
 * renewal (utils/seedGoalTimeline.js), so the goal now points at cycle 2.
 *
 * Weekly checkpoint dates: cycle 1 = today-28, -21, -14, -7 (Weeks 1-4),
 * cycle 2 = today (Week 5), +7, +14, +21.
 */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const utcDay = (offsetDays = 0) => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + offsetDays * MS_PER_DAY);
};
const dayKey = (date) => new Date(date).toISOString().slice(0, 10);

async function createTwoCyclePatient({ startWeight = 75, targetWeight = 60 } = {}) {
  const { DietPlan } = require('../../models');
  const { seedGoalTimeline } = require('../../utils/seedGoalTimeline');
  const { createPatient, createDietician, createDietPlanRequest } = require('./factories');

  const dietician = await createDietician();
  const patient = await createPatient({
    healthProfile: {
      bmi: 22,
      weightIndex: 0,
      weight: startWeight,
      height: 170,
      targetWeight: String(targetWeight),
    },
  });
  await createDietPlanRequest(patient, dietician, {
    status: 'Paid',
    hasActivePlan: true,
    subscriptionExpiresAt: utcDay(60),
  });

  const cycle1Start = utcDay(-34);
  const cycle2Start = utcDay(-6);
  const makePlan = (cycleNumber, status, start) =>
    DietPlan.create({
      patientId: patient._id,
      dieticianId: dietician._id,
      status,
      cycleNumber,
      startDate: start,
      weekSchedule: [
        { week: 1, startDate: start, endDate: new Date(start.getTime() + 27 * MS_PER_DAY) },
      ],
    });
  const plan1 = await makePlan(1, 'Completed', cycle1Start);
  await seedGoalTimeline(plan1);
  const plan2 = await makePlan(2, 'Active', cycle2Start);
  const goal = await seedGoalTimeline(plan2);

  return { patient, dietician, plan1, plan2, goal, cycle1Start, cycle2Start };
}

module.exports = { createTwoCyclePatient, utcDay, dayKey, MS_PER_DAY };
