// Membership plan names are stored as a free-form string on DietPlanRequest
// (see docwellness-user's request_diet_plan.view.dart for the canonical
// "Silver Membership" / "Golden Membership" / "Platinum Membership" copy) -
// matched case-insensitively on substring so a copy tweak doesn't silently
// break tier-gated generation logic.
const TIER_KEYWORDS = {
  silver: 'silver',
  golden: 'golden',
  platinum: 'platinum',
};

function getMembershipTier(membershipPlan) {
  if (!membershipPlan) return null;
  const normalized = String(membershipPlan).toLowerCase();
  for (const [tier, keyword] of Object.entries(TIER_KEYWORDS)) {
    if (normalized.includes(keyword)) return tier;
  }
  return null;
}

// Weeks generated in the single initial "Create Diet Plan" action, per tier:
// Silver gets all 4 up front (no regeneration ever offered), Golden gets
// weeks 1-2 (one shared strategy), Platinum gets week 1 only.
const TIER_INITIAL_WEEKS = {
  silver: [1, 2, 3, 4],
  golden: [1, 2],
  platinum: [1],
};

// Validates a later regenerate-week request against the tier's allowed
// cadence and the diet plan's current state (which weeks already exist in
// generatedPlan). Returns { ok: true } or { ok: false, message }.
function validateRegenerateRequest({ tier, weekNumbers, existingWeekNumbers, finalizedWeekNumbers }) {
  if (tier === 'silver' || !tier) {
    return { ok: false, message: 'This membership plan does not support week regeneration.' };
  }

  const existing = new Set(existingWeekNumbers || []);
  const finalized = new Set(finalizedWeekNumbers || []);

  if (tier === 'golden') {
    const isWeeks3And4 = weekNumbers.length === 2 && weekNumbers[0] === 3 && weekNumbers[1] === 4;
    if (!isWeeks3And4) {
      return { ok: false, message: 'Golden plans can only regenerate weeks 3 and 4 together.' };
    }
    if (!finalized.has(2)) {
      return { ok: false, message: 'Week 2 must be finalized before weeks 3-4 can be generated.' };
    }
    return { ok: true };
  }

  if (tier === 'platinum') {
    if (weekNumbers.length !== 1) {
      return { ok: false, message: 'Platinum plans generate one week at a time.' };
    }
    const week = weekNumbers[0];
    if (week < 2 || week > 4) {
      return { ok: false, message: 'Only weeks 2-4 can be generated after the initial plan.' };
    }
    if (existing.has(week)) {
      // Allow redoing an already-generated week, but only once it's the
      // latest one (not skipping ahead of a not-yet-finalized later week).
    }
    if (!finalized.has(week - 1)) {
      return { ok: false, message: `Week ${week - 1} must be finalized before week ${week} can be generated.` };
    }
    return { ok: true };
  }

  return { ok: false, message: 'Unknown membership tier.' };
}

module.exports = {
  getMembershipTier,
  TIER_INITIAL_WEEKS,
  validateRegenerateRequest,
};
