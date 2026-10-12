/**
 * Patient journey stages (openspec add-admin-panel: admin-user-management).
 * A patient can have a request and a chosen plan long before any subscription
 * end date exists; the stage must say so.
 */
const { computeStage, buildJourney } = require('../utils/patientJourney');

const DAY = 86400_000;
const now = new Date('2026-10-12T10:00:00Z');
const req = (over = {}) => ({
  _id: 'r1',
  status: 'Unpaid',
  hasActivePlan: false,
  membershipPlan: '3 months',
  membershipAmount: 9000,
  subscriptionExpiresAt: null,
  createdAt: new Date(now.getTime() - 5 * DAY),
  ...over,
});

describe('computeStage', () => {
  it('no request is "none"', () => {
    expect(computeStage({ request: null, now }).stage).toBe('none');
  });

  it('request sent with a plan chosen but nothing else is "requested", not "never subscribed"', () => {
    expect(computeStage({ request: req(), now }).stage).toBe('requested');
  });

  it('a draft or finalized plan means the dietician is working on it', () => {
    expect(computeStage({ request: req(), hasDraftPlan: true, now }).stage).toBe('diet_in_progress');
  });

  it('payment requested and payment submitted are their own stages', () => {
    expect(computeStage({ request: req({ status: 'PaymentRequested' }), hasDraftPlan: true, now }).stage).toBe('payment_requested');
    expect(computeStage({ request: req({ status: 'PaymentSubmitted' }), hasDraftPlan: true, now }).stage).toBe('payment_submitted');
  });

  it('an active plan is active, expiring within 7 days, or expired', () => {
    const base = { status: 'Paid', hasActivePlan: true };
    expect(computeStage({ request: req({ ...base, subscriptionExpiresAt: new Date(now.getTime() + 30 * DAY) }), now }).stage).toBe('active');
    expect(computeStage({ request: req({ ...base, subscriptionExpiresAt: new Date(now.getTime() + 3 * DAY) }), now }).stage).toBe('expiring');
    expect(computeStage({ request: req({ ...base, subscriptionExpiresAt: new Date(now.getTime() - DAY) }), now }).stage).toBe('expired');
  });

  it('a partial payment on a running plan stays active but flags the balance', () => {
    const r = computeStage({ request: req({ status: 'PartiallyPaid', hasActivePlan: true, subscriptionExpiresAt: new Date(now.getTime() + 20 * DAY) }), now });
    expect(r).toMatchObject({ stage: 'active', pendingBalance: true });
  });

  it('a running member who is renewing is still active, flagged as renewing', () => {
    const r = computeStage({ request: req({ status: 'PaymentSubmitted', hasActivePlan: true, subscriptionExpiresAt: new Date(now.getTime() + 2 * DAY) }), now });
    expect(r).toMatchObject({ stage: 'expiring', renewalInProgress: true });
  });

  it('a lapsed paid membership with no active plan is expired', () => {
    expect(computeStage({ request: req({ status: 'Paid', subscriptionExpiresAt: new Date(now.getTime() - 10 * DAY) }), now }).stage).toBe('expired');
  });
});

describe('buildJourney', () => {
  it('shows only the request as done for a patient who has just applied, with the chosen plan', () => {
    const steps = buildJourney({ request: req(), plans: [], proofs: [] });
    expect(steps.map((s) => [s.key, s.done])).toEqual([
      ['requested', true],
      ['diet_created', false],
      ['diet_ready', false],
      ['payment_requested', false],
      ['payment_submitted', false],
      ['started', false],
    ]);
    expect(steps[0].detail).toBe('Chose 3 months (9000)');
  });

  it('marks each step as it is reached through to a started diet', () => {
    const t = (d) => new Date(now.getTime() - d * DAY);
    const steps = buildJourney({
      request: req({ status: 'Paid', hasActivePlan: true, paymentRequestedAt: t(3), subscriptionStartDate: t(1), subscriptionExpiresAt: new Date(now.getTime() + 29 * DAY) }),
      plans: [{ status: 'Active', createdAt: t(4), updatedAt: t(2) }],
      proofs: [{ status: 'Approved', createdAt: t(2), reviewedAt: t(1) }],
    });
    expect(steps.every((s) => s.done)).toBe(true);
    expect(steps.find((s) => s.key === 'started').detail).toMatch(/Runs until \d{4}-\d{2}-\d{2}/);
  });

  it('is empty without a request', () => {
    expect(buildJourney({ request: null })).toEqual([]);
  });
});
