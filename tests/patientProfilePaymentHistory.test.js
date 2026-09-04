/**
 * getPatientProfile's paymentSummary/paymentHistory bucketing (see
 * controllers/dietician/patientController.js). A renewal reuses the same
 * DietPlanRequest document, so ManualPaymentProof documents from an OLD
 * cycle and the CURRENT one both point at the same `request` id - this
 * locks in that the two don't get summed together (the bug this test
 * guards against) and that each cycle's own payment shows up as its own
 * dated paymentHistory entry.
 */

const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

jest.mock('../utils/supabaseAuth');
const { registerTestToken, clearTestTokens } = require('../utils/supabaseAuth');

let request;
let app;
let createPatient;
let createDietician;
let createDietPlanRequest;
let DietPlan;
let ManualPaymentProof;

beforeAll(async () => {
  await connectTestDb();
  request = require('supertest');
  app = require('../config/createApp')();
  ({ createPatient, createDietician, createDietPlanRequest } = require('./helpers/factories'));
  ({ DietPlan, ManualPaymentProof } = require('../models'));
});

afterEach(async () => {
  clearTestTokens();
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

const getProfile = (token, patientId) =>
  request(app)
    .get(`/api/dietician/patients/${patientId}/profile`)
    .set('Authorization', `Bearer ${token}`);

/** Bypasses the timestamps plugin (which always stamps createdAt on
 * .create()) so test documents can be dated into distinct cycle windows. */
async function setCreatedAt(Model, id, date) {
  await Model.collection.updateOne({ _id: id }, { $set: { createdAt: date } });
}

describe('GET /api/dietician/patients/:id/profile - payment history', () => {
  test('a patient who never renewed gets one paymentHistory entry matching paymentSummary', async () => {
    const dietician = await createDietician();
    const patient = await createPatient();
    const dietPlanRequest = await createDietPlanRequest(patient, dietician, {
      status: 'Paid',
      hasActivePlan: true,
      membershipPlan: 'Golden Membership',
    });
    const plan = await DietPlan.create({
      patientId: patient._id,
      dieticianId: dietician._id,
      request: dietPlanRequest._id,
      status: 'Active',
      cycleNumber: 1,
      membershipPlan: 'Golden Membership',
      activationDate: new Date('2026-08-01'),
    });
    await ManualPaymentProof.create({
      request: dietPlanRequest._id,
      patient: patient._id,
      amountReceived: 2500,
      amountPending: 0,
      status: 'Approved',
    });

    registerTestToken('d', dietician._id);
    const res = await getProfile('d', patient._id.toString());

    expect(res.status).toBe(200);
    expect(res.body.data.status.paymentSummary.amountReceived).toBe(2500);
    expect(res.body.data.paymentHistory).toHaveLength(1);
    expect(res.body.data.paymentHistory[0]).toEqual(
      expect.objectContaining({
        membershipPlan: 'Golden Membership',
        isCurrent: true,
        dietPlanId: plan._id.toString(),
      })
    );
    expect(res.body.data.paymentHistory[0].paymentSummary.amountReceived).toBe(2500);
  });

  test('a renewed patient does not sum the old cycle\'s payment into the current one', async () => {
    const dietician = await createDietician();
    const patient = await createPatient();
    const dietPlanRequest = await createDietPlanRequest(patient, dietician, {
      status: 'Paid',
      hasActivePlan: true,
      membershipPlan: 'Silver Membership',
    });

    // Cycle 1 (old, Golden, ₹2500) - built and paid first.
    const cycle1 = await DietPlan.create({
      patientId: patient._id,
      dieticianId: dietician._id,
      request: dietPlanRequest._id,
      status: 'Completed',
      cycleNumber: 1,
      membershipPlan: 'Golden Membership',
      activationDate: new Date('2026-08-01'),
    });
    await setCreatedAt(DietPlan, cycle1._id, new Date('2026-08-01'));
    const proof1 = await ManualPaymentProof.create({
      request: dietPlanRequest._id,
      patient: patient._id,
      amountReceived: 2500,
      amountPending: 0,
      status: 'Approved',
    });
    await setCreatedAt(ManualPaymentProof, proof1._id, new Date('2026-08-02'));

    // Cycle 2 (current, Silver, ₹1500) - built after cycle 1 was fully paid.
    const cycle2 = await DietPlan.create({
      patientId: patient._id,
      dieticianId: dietician._id,
      request: dietPlanRequest._id,
      status: 'Active',
      cycleNumber: 2,
      membershipPlan: 'Silver Membership',
      activationDate: new Date('2026-09-05'),
    });
    await setCreatedAt(DietPlan, cycle2._id, new Date('2026-09-04'));
    const proof2 = await ManualPaymentProof.create({
      request: dietPlanRequest._id,
      patient: patient._id,
      amountReceived: 1500,
      amountPending: 0,
      status: 'Approved',
    });
    await setCreatedAt(ManualPaymentProof, proof2._id, new Date('2026-09-05'));

    await require('../models').User.findByIdAndUpdate(patient._id, {
      $set: { 'status.activeDietPlanId': cycle2._id },
    });

    registerTestToken('d', dietician._id);
    const res = await getProfile('d', patient._id.toString());

    expect(res.status).toBe(200);
    // The bug this guards against: summing both cycles' approved proofs
    // would report 4000 here instead of just the current cycle's 1500.
    expect(res.body.data.status.paymentSummary.amountReceived).toBe(1500);
    expect(res.body.data.status.membershipPlan).toBe('Silver Membership');

    const history = res.body.data.paymentHistory;
    expect(history).toHaveLength(2);
    // Newest cycle first.
    expect(history[0]).toEqual(
      expect.objectContaining({
        cycleNumber: 2,
        membershipPlan: 'Silver Membership',
        isCurrent: true,
      })
    );
    expect(history[0].paymentSummary.amountReceived).toBe(1500);
    expect(history[1]).toEqual(
      expect.objectContaining({
        cycleNumber: 1,
        membershipPlan: 'Golden Membership',
        isCurrent: false,
      })
    );
    expect(history[1].paymentSummary.amountReceived).toBe(2500);
  });
});
