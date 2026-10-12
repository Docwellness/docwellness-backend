/**
 * Where a patient is in the journey from "sent a diet plan request" to
 * "diet running" (openspec: admin-user-management). Pure, no I/O.
 *
 * The real flow in this product:
 *   1. The patient sends a diet plan request and picks a membership plan.
 *   2. The dietician builds the diet plan (Draft, then Finalized).
 *   3. The dietician asks for payment; the patient submits a payment proof.
 *   4. The dietician activates the plan. Only then is the first payment
 *      settled and the membership clock started.
 * So a patient can have a request and a chosen plan for a long time without
 * any subscription end date. An end date alone cannot describe that.
 */

const DAY = 24 * 3600 * 1000;

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
 * @param {Date} [args.now]
 */
function computeStage({ request, hasDraftPlan = false, now = new Date() }) {
  if (!request) return { stage: 'none', pendingBalance: false, renewalInProgress: false };

  const t = new Date(now).getTime();
  const expires = request.subscriptionExpiresAt ? new Date(request.subscriptionExpiresAt).getTime() : null;
  const pendingBalance = request.status === 'PartiallyPaid';

  if (request.hasActivePlan) {
    let stage = 'active';
    if (expires !== null && expires < t) stage = 'expired';
    else if (expires !== null && expires < t + 7 * DAY) stage = 'expiring';
    // A running member who is renewing: payment asked for or sent for the next cycle.
    const renewalInProgress = ['PaymentRequested', 'PaymentSubmitted'].includes(request.status);
    return { stage, pendingBalance, renewalInProgress };
  }

  if (request.status === 'PaymentSubmitted') return { stage: 'payment_submitted', pendingBalance, renewalInProgress: false };
  if (request.status === 'PaymentRequested') return { stage: 'payment_requested', pendingBalance, renewalInProgress: false };
  if (hasDraftPlan) return { stage: 'diet_in_progress', pendingBalance, renewalInProgress: false };
  // Paid / PartiallyPaid without an active plan (e.g. a lapsed, completed cycle).
  if (expires !== null && expires < t && ['Paid', 'PartiallyPaid'].includes(request.status)) {
    return { stage: 'expired', pendingBalance, renewalInProgress: false };
  }
  return { stage: 'requested', pendingBalance, renewalInProgress: false };
}

/**
 * Timeline of the journey for the detail view. A step is `done` once reached.
 * @param {{request: object|null, plans: object[], proofs: object[]}} data
 */
function buildJourney({ request, plans = [], proofs = [] }) {
  if (!request) return [];
  const firstPlan = [...plans].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0] || null;
  const finalized = plans.find((p) => ['Finalized', 'Active', 'Completed'].includes(p.status)) || null;
  const firstProof = [...proofs].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0] || null;
  const approved = proofs.find((p) => p.status === 'Approved') || null;
  const started = request.subscriptionStartDate || null;

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
      key: 'started',
      label: 'Diet started, payment confirmed',
      done: Boolean(started) && Boolean(request.hasActivePlan || approved),
      at: started || approved?.reviewedAt || null,
      detail: request.subscriptionExpiresAt ? `Runs until ${new Date(request.subscriptionExpiresAt).toISOString().slice(0, 10)}` : '',
    },
  ];
}

module.exports = { STAGES, computeStage, buildJourney };
