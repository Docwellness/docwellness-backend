/**
 * Past orders for the patient's "Your Orders" list.
 *
 * A repurchase (renewal) does not create a new DietPlanRequest: it reuses the
 * patient's one request, overwriting its plan/amount/start date and flipping
 * it back to Unpaid (see dietPlanRequestController.createDietPlanRequest). So
 * the request row only ever describes the CURRENT order. Every earlier cycle
 * survives as a DietPlan (cycleNumber, membershipPlan snapshot, start date),
 * which is what these helpers turn back into order rows.
 *
 * A past order's id is `<requestId>~c<cycleNumber>`; getRequestById resolves
 * it to a read-only Order Summary for that cycle.
 */
const { getMembershipPrice } = require('./membershipTiers');
const { resolvePlanStartDate } = require('./trackingBuckets');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Cycles are weeks apart, so a plan starting within this many days of the
// request's start date IS the current order (a dietician can nudge the plan's
// start a little from what the patient picked), not a past one.
const SAME_CYCLE_TOLERANCE_DAYS = 7;

const PAST_ORDER_ID = /^([a-f\d]{24})~c(\d+)$/i;

const pastOrderId = (requestId, cycleNumber) => `${requestId}~c${cycleNumber}`;

// { requestId, cycleNumber } for a past-order id, null for a plain request id.
function parsePastOrderId(id) {
  const match = PAST_ORDER_ID.exec(String(id || ''));
  return match ? { requestId: match[1], cycleNumber: Number(match[2]) } : null;
}

// The plans of `request` that are earlier cycles than the order the request
// row itself currently describes, oldest first. `plans` are that patient's
// non-Draft DietPlans (any request; filtered here).
function pastCyclePlans(request, plans) {
  const mine = (plans || [])
    .filter((p) => String(p.request) === String(request._id))
    .sort((a, b) => (a.cycleNumber || 1) - (b.cycleNumber || 1));
  if (mine.length === 0) return [];

  const requestStart = request.startDateForDiet ? new Date(request.startDateForDiet) : null;
  if (requestStart && !Number.isNaN(requestStart.getTime())) {
    const cutoff = requestStart.getTime() - SAME_CYCLE_TOLERANCE_DAYS * MS_PER_DAY;
    return mine.filter((p) => {
      const start = resolvePlanStartDate(p);
      return start && start.getTime() < cutoff;
    });
  }
  // No start date on the request to compare with: the latest cycle is the
  // current order, everything before it is past.
  return mine.slice(0, -1);
}

// A past order, shaped like a listRequests row.
function pastOrderRow(request, plan) {
  const membershipPlan = plan.membershipPlan || request.membershipPlan || null;
  return {
    requestId: pastOrderId(request._id, plan.cycleNumber || 1),
    status: 'Paid',
    isEditable: false,
    // The request's own createdAt is when the patient first ordered, i.e. the
    // first cycle's order date; later cycles were placed when their plan was
    // created.
    createdAt: (plan.cycleNumber || 1) === 1 ? request.createdAt : plan.createdAt,
    startDateForDiet: resolvePlanStartDate(plan),
    membershipPlan,
    membershipAmount: getMembershipPrice(membershipPlan) ?? null,
  };
}

// Overrides that turn the request's current Order Summary detail into the
// read-only detail of one past cycle. The personal-info snapshot on the
// request is whatever the patient last submitted, so it is shown as is; the
// payment, dates and plan are this cycle's.
function pastOrderDetailOverrides(request, plan) {
  const row = pastOrderRow(request, plan);
  return {
    requestId: row.requestId,
    status: 'Paid',
    isEditable: false,
    paymentRequested: false,
    paymentRequestedAt: null,
    paymentSummary: null,
    startDateForDiet: row.startDateForDiet,
    createdAt: row.createdAt,
    subscriptionStartDate: null,
    subscriptionExpiresAt: null,
    membershipPlan: row.membershipPlan,
    membershipAmount: row.membershipAmount,
  };
}

module.exports = {
  pastOrderId,
  parsePastOrderId,
  pastCyclePlans,
  pastOrderRow,
  pastOrderDetailOverrides,
};
