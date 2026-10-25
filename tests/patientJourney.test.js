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
      ['payment_confirmed', false],
      ['diet_started', false],
    ]);
    expect(steps[0].detail).toBe('Chose 3 months (9000)');
  });

  it('marks each step as it is reached through to a started diet', () => {
    const t = (d) => new Date(now.getTime() - d * DAY);
    const steps = buildJourney({
      request: req({ status: 'Paid', hasActivePlan: true, paymentRequestedAt: t(3), subscriptionStartDate: t(1), subscriptionExpiresAt: new Date(now.getTime() + 29 * DAY) }),
      plans: [{ status: 'Active', createdAt: t(4), updatedAt: t(2) }],
      proofs: [{ status: 'Approved', amountReceived: 9000, amountPending: 0, createdAt: t(2), reviewedAt: t(1) }],
    });
    expect(steps.every((s) => s.done)).toBe(true);
    expect(steps.find((s) => s.key === 'payment_confirmed').detail).toBe('9000 received');
    expect(steps.find((s) => s.key === 'diet_started').detail).toMatch(/Runs until \d{4}-\d{2}-\d{2}/);
  });

  it('keeps "payment confirmed" and "diet started" separate: the diet can run before the payment is settled', () => {
    const t = (d) => new Date(now.getTime() - d * DAY);
    const steps = buildJourney({
      request: req({ status: 'PaymentSubmitted', hasActivePlan: true, subscriptionStartDate: t(1), subscriptionExpiresAt: new Date(now.getTime() + 29 * DAY) }),
      plans: [{ status: 'Active', createdAt: t(4), updatedAt: t(2), activationDate: t(1) }],
      proofs: [{ status: 'Submitted', amountReceived: 9000, amountPending: 0, createdAt: t(1) }],
    });
    const step = (k) => steps.find((s) => s.key === k);
    expect(step('payment_submitted').done).toBe(true);
    expect(step('payment_confirmed').done).toBe(false);
    expect(step('diet_started').done).toBe(true);
    expect(new Date(step('diet_started').at).getTime()).toBe(t(1).getTime());
  });

  it('shows the amounts on a partly paid, confirmed payment', () => {
    const t = (d) => new Date(now.getTime() - d * DAY);
    const steps = buildJourney({
      request: req({ status: 'PartiallyPaid', hasActivePlan: true, subscriptionStartDate: t(1) }),
      plans: [{ status: 'Active', createdAt: t(4), updatedAt: t(2), activationDate: t(1) }],
      proofs: [{ status: 'Approved', amountReceived: 5000, amountPending: 4000, createdAt: t(2), reviewedAt: t(1) }],
    });
    const confirmed = steps.find((s) => s.key === 'payment_confirmed');
    expect(confirmed.done).toBe(true);
    expect(confirmed.detail).toBe('5000 received, 4000 still pending');
    expect(new Date(confirmed.at).getTime()).toBe(t(1).getTime());
  });

  it('is empty without a request', () => {
    expect(buildJourney({ request: null })).toEqual([]);
  });
});

describe('computeStage with a plan end day (last plan week)', () => {
  const live = { status: 'Paid', hasActivePlan: true, subscriptionExpiresAt: new Date('2026-10-26T06:00:00.000Z') };
  const at = (iso) => new Date(iso);

  it('is expired the day after the end day even though the membership runs on', () => {
    const r = computeStage({ request: req(live), endDay: '2026-10-18', now: at('2026-10-25T06:00:00.000Z') });
    expect(r.stage).toBe('expired');
  });

  it('the end day itself is not expired yet and is ending soon', () => {
    const r = computeStage({ request: req(live), endDay: '2026-10-25', now: at('2026-10-25T06:00:00.000Z') });
    expect(r.stage).toBe('expiring');
  });

  it('ending soon only inside 7 days of the end day', () => {
    expect(computeStage({ request: req(live), endDay: '2026-11-01', now: at('2026-10-25T06:00:00.000Z') }).stage).toBe('active');
    expect(computeStage({ request: req(live), endDay: '2026-10-31', now: at('2026-10-25T06:00:00.000Z') }).stage).toBe('expiring');
  });

  it('a lapsed paid cycle without an active plan is expired by the end day too', () => {
    const r = computeStage({ request: req({ status: 'Paid', hasActivePlan: false, subscriptionExpiresAt: live.subscriptionExpiresAt }), endDay: '2026-10-18', now: at('2026-10-25T06:00:00.000Z') });
    expect(r.stage).toBe('expired');
  });

  it('without an end day the membership expiry still decides', () => {
    expect(computeStage({ request: req(live), now: at('2026-10-25T06:00:00.000Z') }).stage).toBe('expiring');
  });
});
