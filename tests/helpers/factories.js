/**
 * Minimal test-data factories - AI_EXECUTION_PLAN.md Phase 8, P8-01.
 * Every field here is synthetic/obviously fake test data, never a real
 * credential or PHI (see AI_RULES.md: "do not store secrets in tests").
 */

const { User, DietPlanRequest, DietPlan } = require('../../models');
const { DEFAULT_DIETICIAN_ID } = require('./testDb');

let counter = 0;
function unique(prefix) {
  counter += 1;
  return `${prefix}${Date.now()}${counter}`;
}

async function createPatient(overrides = {}) {
  return User.create({
    supabaseUserId: unique('sb-patient-'),
    email: `${unique('patient')}@example.test`,
    role: 'patient',
    profile: { fullName: 'Test Patient' },
    healthProfile: { bmi: 22, weightIndex: 0 },
    ...overrides,
  });
}

async function createDietician(overrides = {}) {
  return User.create({
    supabaseUserId: unique('sb-dietician-'),
    email: `${unique('dietician')}@example.test`,
    role: 'dietician',
    profile: { fullName: 'Test Dietician' },
    healthProfile: { bmi: 22, weightIndex: 0 },
    ...overrides,
  });
}

/**
 * A dietician whose _id matches config.defaultDieticianId (see
 * testDb.js) - needed by any test exercising a code path that reads that
 * config value (patient-side chat auto-routing, meal-log chat-sync), since
 * it can't be pointed at an arbitrary per-test id.
 */
async function createDefaultDietician(overrides = {}) {
  return createDietician({ _id: DEFAULT_DIETICIAN_ID, ...overrides });
}

async function createDietPlanRequest(patient, dietician, overrides = {}) {
  return DietPlanRequest.create({
    patient: patient._id,
    dieticianId: dietician._id,
    startDateForDiet: new Date(),
    fullName: patient.profile?.fullName || 'Test Patient',
    ...overrides,
  });
}

async function createActiveDietPlan(patient, dietician, overrides = {}) {
  return DietPlan.create({
    patientId: patient._id,
    dieticianId: dietician._id,
    status: 'Active',
    startDate: new Date(),
    ...overrides,
  });
}

module.exports = {
  createPatient,
  createDietician,
  createDefaultDietician,
  createDietPlanRequest,
  createActiveDietPlan,
};
