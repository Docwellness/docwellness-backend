/**
 * Where a patient is in the journey from "sent a diet plan request" to
 * "diet running" (openspec: admin-user-management). Pure, no I/O.
 *
 * The real flow in this product:
 *   1. The patient sends a diet plan request and picks a membership plan.
 *   2. The dietician builds the diet plan (Draft, then Finalized).
 *   3. The dietician asks for payment; the patient submits a payment proof.
 *   4. The dietician activates the plan. For a first payment this is when
 *      the proof is approved and the membership clock starts, but the two are
 *      tracked as separate steps in the timeline because they can differ.
 * So a patient can have a request and a chosen plan for a long time without
 * any subscription end date. An end date alone cannot describe that.
 */

const DAY = 24 * 3600 * 1000;
const IST_OFFSET_MS = 5.5 * 3600 * 1000;

const STAGES = [
  'none', // never sent a request
  'requested', // request sent, plan chosen, dietician has not started
  'diet_in_progress', // dietician is building / has finalized the plan
  'payment_requested', // dietician asked for payment
  'payment_submitted', // patient sent a proof, waiting to be confirmed
  'active', // diet running
  'expiring', // diet running, ends within 7 days
  'expired', // membership ended
];

/**
 * @param {object} args
 * @param {object|null} args.request   latest DietPlanRequest (lean) or null
 * @param {boolean} args.hasDraftPlan  patient has a Draft or Finalized plan that is not yet active
 * @param {string|null} [args.endDay] plan end day 'YYYY-MM-DD' (utils/planEnd.js, the last plan
 *   week). When given it replaces the membership expiry: expired from the day after it,
 *   ending soon from 7 days before it.
 * @param {Date} [args.now]
 */
function computeStage({ request, hasDraftPlan = false, endDay = null, now = new Date() }) {
  if (!request) return { stage: 'none', pendingBalance: false, renewalInProgress: false };

  const t = new Date(now).getTime();
  const expires = request.subscriptionExpiresAt ? new Date(request.subscriptionExpiresAt).getTime() : null;
  const pendingBalance = request.status === 'PartiallyPaid';
  const todayKey = new Date(t + IST_OFFSET_MS).toISOString().slice(0, 10);
  const ended = endDay ? todayKey > endDay : expires !== null && expires < t;
  const endsSoon = endDay
    ? new Date(`${endDay}T00:00:00Z`).getTime() - new Date(`${todayKey}T00:00:00Z`).getTime() < 7 * DAY
    : expires !== null && expires < t + 7 * DAY;

  if (request.hasActivePlan) {
    let stage = 'active';
    if (ended) stage = 'expired';
    else if (endsSoon) stage = 'expiring';
    // A running member who is renewing: payment asked for or sent for the next cycle.
    const renewalInProgress = ['PaymentRequested', 'PaymentSubmitted'].includes(request.status);
    return { stage, pendingBalance, renewalInProgress };
  }

  if (request.status === 'PaymentSubmitted') return { stage: 'payment_submitted', pendingBalance, renewalInProgress: false };
  if (request.status === 'PaymentRequested') return { stage: 'payment_requested', pendingBalance, renewalInProgress: false };
  if (hasDraftPlan) return { stage: 'diet_in_progress', pendingBalance, renewalInProgress: false };
  // Paid / PartiallyPaid without an active plan (e.g. a lapsed, completed cycle).
  if (ended && ['Paid', 'PartiallyPaid'].includes(request.status)) {
    return { stage: 'expired', pendingBalance, renewalInProgress: false };
  }
  return { stage: 'requested', pendingBalance, renewalInProgress: false };
}

/**
 * Timeline of the journey for the detail view. A step is `done` once reached.
 * @param {{request: object|null, plans: object[], proofs: object[]}} data (proofs need status, amountReceived, amountPending, createdAt, reviewedAt)
 */
function buildJourney({ request, plans = [], proofs = [] }) {
  if (!request) return [];
  const firstPlan = [...plans].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0] || null;
  const finalized = plans.find((p) => ['Finalized', 'Active', 'Completed'].includes(p.status)) || null;
  const firstProof = [...proofs].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0] || null;
  const approved = proofs.find((p) => p.status === 'Approved') || null;
  const running = plans.find((p) => ['Active', 'Completed'].includes(p.status)) || null;
  const settled = Boolean(approved) || ['Paid', 'PartiallyPaid'].includes(request.status);
  const dayOf = (d) => new Date(d).toISOString().slice(0, 10);

  let paymentDetail = '';
  if (approved && Number.isFinite(approved.amountReceived)) {
    paymentDetail = `${approved.amountReceived} received`;
    if (approved.amountPending > 0) paymentDetail += `, ${approved.amountPending} still pending`;
  } else if (request.status === 'PartiallyPaid') {
    paymentDetail = 'Part paid, a balance is pending';
  }

  return [
    {
      key: 'requested',
      label: 'Diet plan request sent',
      done: true,
      at: request.createdAt,
      detail: request.membershipPlan
        ? `Chose ${request.membershipPlan}${request.membershipAmount ? ` (${request.membershipAmount})` : ''}`
        : 'No membership plan chosen',
    },
    {
      key: 'diet_created',
      label: 'Dietician started the diet plan',
      done: Boolean(firstPlan),
      at: firstPlan?.createdAt || null,
      detail: firstPlan ? `Plan is ${firstPlan.status === 'Draft' ? 'being built' : firstPlan.status.toLowerCase()}` : '',
    },
    {
      key: 'diet_ready',
      label: 'Diet plan finalized',
      done: Boolean(finalized),
      at: finalized?.updatedAt || null,
      detail: '',
    },
    {
      key: 'payment_requested',
      label: 'Payment requested',
      done: Boolean(request.paymentRequestedAt || request.paymentRequested),
      at: request.paymentRequestedAt || null,
      detail: '',
    },
    {
      key: 'payment_submitted',
      label: 'Payment proof sent',
      done: Boolean(firstProof),
      at: firstProof?.createdAt || null,
      detail: firstProof ? `${proofs.length} proof${proofs.length === 1 ? '' : 's'} sent` : '',
    },
    {
      // Confirmed when the proof is approved: by the dietician when they
      // activate the plan, or by an admin for a renewal.
      key: 'payment_confirmed',
      label: 'Payment confirmed',
      done: settled,
      at: approved?.reviewedAt || null,
      detail: paymentDetail,
    },
    {
      // The diet is running once the plan is activated. This can happen
      // before or after the payment is confirmed, so it is its own step.
      key: 'diet_started',
      label: 'Diet started',
      done: Boolean(running) || Boolean(request.hasActivePlan),
      at: running?.activationDate || request.subscriptionStartDate || null,
      detail: request.subscriptionExpiresAt ? `Runs until ${dayOf(request.subscriptionExpiresAt)}` : '',
    },
  ];
}

module.exports = { STAGES, computeStage, buildJourney };
