/**
 * AI_EXECUTION_PLAN.md Phase 8, P8-01 - payment status transition. Real
 * payment collection goes through manual proof + Cloudinary upload
 * (external services, not practical or desirable to hit in an
 * integration test) - this exercises the confirm-renewal-payment
 * transition directly against a pre-seeded ManualPaymentProof document
 * (no file upload needed for that specific endpoint), which is where the
 * actual status-transition logic under test lives.
 */

const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/supabaseAuth');
const { registerTestToken, clearTestTokens } = require('../utils/supabaseAuth');

let request;
let app;
let createPatient;
let createDietician;
let createDietPlanRequest;
let createActiveDietPlan;
let ManualPaymentProof;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({
    createPatient,
    createDietician,
    createDietPlanRequest,
    createActiveDietPlan,
  } = require('./helpers/factories'));
  ({ ManualPaymentProof } = require('../models'));
});

afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe('PUT /api/dietician/patients/:patientId/payments/manual-proofs/:proofId/confirm', () => {
  test('Submitted -> Approved transitions the request to Paid when nothing is pending', async () => {
    const dietician = await createDietician();
    const patient = await createPatient();
    const dietPlanRequest = await createDietPlanRequest(patient, dietician, {
      status: 'PaymentSubmitted',
    });
    await createActiveDietPlan(patient, dietician);
    const proof = await ManualPaymentProof.create({
      request: dietPlanRequest._id,
      patient: patient._id,
      amountReceived: 5000,
      amountPending: 0,
      status: 'Submitted',
    });
    registerTestToken('dietician-token', dietician._id);

    const res = await request(app)
      .put(
        `/api/dietician/patients/${patient._id}/payments/manual-proofs/${proof._id}/confirm`
      )
      .set('Authorization', 'Bearer dietician-token');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const updatedProof = await ManualPaymentProof.findById(proof._id);
    expect(updatedProof.status).toBe('Approved');

    const updatedRequest = await require('../models').DietPlanRequest.findById(
      dietPlanRequest._id
    );
    expect(updatedRequest.status).toBe('Paid');
    expect(updatedRequest.hasActivePlan).toBe(true);
  });

  test('Submitted -> Approved with a pending balance transitions the request to PartiallyPaid', async () => {
    const dietician = await createDietician();
    const patient = await createPatient();
    const dietPlanRequest = await createDietPlanRequest(patient, dietician, {
      status: 'PaymentSubmitted',
    });
    await createActiveDietPlan(patient, dietician);
    const proof = await ManualPaymentProof.create({
      request: dietPlanRequest._id,
      patient: patient._id,
      amountReceived: 3000,
      amountPending: 2000,
      status: 'Submitted',
    });
    registerTestToken('dietician-token', dietician._id);

    const res = await request(app)
      .put(
        `/api/dietician/patients/${patient._id}/payments/manual-proofs/${proof._id}/confirm`
      )
      .set('Authorization', 'Bearer dietician-token');

    expect(res.status).toBe(200);
    const updatedRequest = await require('../models').DietPlanRequest.findById(
      dietPlanRequest._id
    );
    expect(updatedRequest.status).toBe('PartiallyPaid');
  });

  test('rejects confirming a proof that is not in Submitted status', async () => {
    const dietician = await createDietician();
    const patient = await createPatient();
    const dietPlanRequest = await createDietPlanRequest(patient, dietician);
    await createActiveDietPlan(patient, dietician);
    const proof = await ManualPaymentProof.create({
      request: dietPlanRequest._id,
      patient: patient._id,
      amountReceived: 5000,
      amountPending: 0,
      status: 'Approved',
    });
    registerTestToken('dietician-token', dietician._id);

    const res = await request(app)
      .put(
        `/api/dietician/patients/${patient._id}/payments/manual-proofs/${proof._id}/confirm`
      )
      .set('Authorization', 'Bearer dietician-token');

    expect(res.status).toBe(400);
  });

  test('rejects a patient-role token entirely (dietician-only route)', async () => {
    const dietician = await createDietician();
    const patient = await createPatient();
    const dietPlanRequest = await createDietPlanRequest(patient, dietician);
    const proof = await ManualPaymentProof.create({
      request: dietPlanRequest._id,
      patient: patient._id,
      amountReceived: 5000,
      amountPending: 0,
      status: 'Submitted',
    });
    registerTestToken('patient-token', patient._id);

    const res = await request(app)
      .put(
        `/api/dietician/patients/${patient._id}/payments/manual-proofs/${proof._id}/confirm`
      )
      .set('Authorization', 'Bearer patient-token');

    expect(res.status).toBe(403);
  });
});
