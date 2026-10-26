/**
 * "Your Orders" must list earlier renewal cycles too. A repurchase reuses the
 * patient's one DietPlanRequest (overwriting its plan/amount/start date), so
 * past orders are rebuilt from the cycles' DietPlans - see utils/pastOrders.js.
 */
const {
  pastOrderId,
  parsePastOrderId,
  pastCyclePlans,
  pastOrderRow,
  pastOrderDetailOverrides,
} = require('../utils/pastOrders');
const { getMembershipPrice } = require('../utils/membershipTiers');

const REQ_ID = '64b7f0c2a1b2c3d4e5f60718';
const day = (iso) => new Date(`${iso}T00:00:00`);
const plan = (cycleNumber, start, membershipPlan = 'Golden Membership') => ({
  request: REQ_ID,
  cycleNumber,
  membershipPlan,
  weekSchedule: [{ startDate: day(start) }],
  createdAt: day(start),
});
const request = (startDateForDiet, extra = {}) => ({
  _id: REQ_ID,
  createdAt: day('2026-09-26'),
  startDateForDiet: day(startDateForDiet),
  membershipPlan: 'Golden Membership',
  ...extra,
});

describe('past order ids', () => {
  it('round-trips a request id and cycle number', () => {
    expect(parsePastOrderId(pastOrderId(REQ_ID, 2))).toEqual({
      requestId: REQ_ID,
      cycleNumber: 2,
    });
  });

  it('treats a plain request id (or junk) as not a past order', () => {
    expect(parsePastOrderId(REQ_ID)).toBeNull();
    expect(parsePastOrderId('abc~c1')).toBeNull();
    expect(parsePastOrderId(undefined)).toBeNull();
  });
});

describe('pastCyclePlans', () => {
  it('lists cycle 1 as a past order once the request was renewed into cycle 2', () => {
    const cycle1 = plan(1, '2026-09-26');
    const cycle2 = plan(2, '2026-10-26');
    const past = pastCyclePlans(request('2026-10-26'), [cycle2, cycle1]);
    expect(past.map((p) => p.cycleNumber)).toEqual([1]);
  });

  it('lists every plan as past while the renewal has no plan built yet', () => {
    const past = pastCyclePlans(request('2026-10-26'), [plan(1, '2026-09-26')]);
    expect(past.map((p) => p.cycleNumber)).toEqual([1]);
  });

  it('has no past orders for a first purchase', () => {
    expect(pastCyclePlans(request('2026-09-26'), [plan(1, '2026-09-26')])).toEqual([]);
    expect(pastCyclePlans(request('2026-09-26'), [])).toEqual([]);
  });

  it('does not duplicate the current order when the plan start drifts a few days', () => {
    expect(pastCyclePlans(request('2026-09-26'), [plan(1, '2026-09-28')])).toEqual([]);
  });

  it('ignores other requests\' plans', () => {
    const other = { ...plan(1, '2026-01-01'), request: '64b7f0c2a1b2c3d4e5f60999' };
    expect(pastCyclePlans(request('2026-10-26'), [other])).toEqual([]);
  });

  it('treats the latest cycle as current when the request has no start date', () => {
    const r = request('2026-10-26', { startDateForDiet: null });
    const past = pastCyclePlans(r, [plan(1, '2026-09-26'), plan(2, '2026-10-26')]);
    expect(past.map((p) => p.cycleNumber)).toEqual([1]);
  });
});

describe('pastOrderRow', () => {
  it('looks like the current order row: membership, placed date, Paid, amount', () => {
    const row = pastOrderRow(request('2026-10-26'), plan(1, '2026-09-26'));
    expect(row).toMatchObject({
      requestId: `${REQ_ID}~c1`,
      status: 'Paid',
      isEditable: false,
      membershipPlan: 'Golden Membership',
      membershipAmount: getMembershipPrice('Golden Membership'),
    });
    expect(row.createdAt).toEqual(day('2026-09-26'));
    expect(row.startDateForDiet).toEqual(day('2026-09-26'));
  });

  it("uses the cycle's own membership snapshot, falling back to the request's", () => {
    const r = request('2026-10-26', { membershipPlan: 'Platinum Membership' });
    expect(pastOrderRow(r, plan(1, '2026-09-26', 'Silver Membership')).membershipPlan).toBe(
      'Silver Membership'
    );
    expect(pastOrderRow(r, plan(1, '2026-09-26', null)).membershipPlan).toBe(
      'Platinum Membership'
    );
  });

  it('dates a later cycle by when its plan was created, not the request', () => {
    const row = pastOrderRow(request('2026-12-01'), plan(2, '2026-10-26'));
    expect(row.createdAt).toEqual(day('2026-10-26'));
  });
});

describe('pastOrderDetailOverrides', () => {
  it("is a read-only Paid detail for that cycle with no current-cycle payment data", () => {
    const o = pastOrderDetailOverrides(request('2026-10-26'), plan(1, '2026-09-26'));
    expect(o).toMatchObject({
      requestId: `${REQ_ID}~c1`,
      status: 'Paid',
      isEditable: false,
      paymentRequested: false,
      paymentSummary: null,
      subscriptionStartDate: null,
      subscriptionExpiresAt: null,
      membershipPlan: 'Golden Membership',
    });
    expect(o.startDateForDiet).toEqual(day('2026-09-26'));
  });
});
