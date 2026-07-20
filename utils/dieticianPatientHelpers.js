const ACTIVITY_MULTIPLIERS = {
  sedentary: 1.2,
  lightly_active: 1.375,
  moderately_active: 1.55,
  very_active: 1.725,
  extra_active: 1.9,
};

// ISSN 2017 Position Stand (JISSN 14:20): 1.4-2.0 g/kg/day covers general
// muscle-gain/strength-training needs; the higher 2.3-3.1 g/kg band only
// applies to an explicit caloric deficit (to preserve lean mass while cutting).
const PROTEIN_G_PER_KG = {
  standard: { min: 1.4, max: 2.0 },
  deficit: { min: 2.3, max: 3.1 },
};

// Generic activity-based water guidance - there is no single authoritative
// "extra water per gram of protein" formula, so this is presented as a range,
// not a precise prescription: ~30 ml/kg/day baseline (common clinical rule of
// thumb) plus an activity-level top-up.
const WATER_ACTIVITY_EXTRA_L = {
  sedentary: 0,
  lightly_active: 0.3,
  moderately_active: 0.5,
  very_active: 0.8,
  extra_active: 1.0,
};

// Category drives the status box's color on the "New" tab patient card -
// distinguishes whose turn it is to act (or that there's nothing left to
// do) rather than just naming the raw DB status.
const STATUS_LABELS = {
  0: { label: 'Awaiting Consultation', category: 'dietician' },
  1: { label: 'Awaiting Patient Consent', category: 'patient' },
  2: { label: 'Diet Plan Pending', category: 'dietician' },
  3: { label: 'Awaiting Payment Request', category: 'dietician' },
  4: { label: 'Awaiting Payment', category: 'patient' },
  5: { label: 'Payment Review', category: 'review' },
  6: { label: 'Payment Confirmed', category: 'done' },
};

const calcAge = (dateOfBirth) => {
  if (!dateOfBirth) {
    return null;
  }

  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) {
    return null;
  }

  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const monthDiff = today.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
    age -= 1;
  }

  return age;
};

const calcBmr = ({ weight, height, age, gender }) => {
  if (
    typeof weight !== 'number' ||
    typeof height !== 'number' ||
    typeof age !== 'number' ||
    Number.isNaN(weight) ||
    Number.isNaN(height) ||
    Number.isNaN(age)
  ) {
    return null;
  }

  const normalizedGender = (gender || '').toLowerCase();
  if (!['male', 'female'].includes(normalizedGender)) {
    return null;
  }

  const base = 10 * weight + 6.25 * height - 5 * age;
  const adjustment = normalizedGender === 'male' ? 5 : -161;
  return Math.round(base + adjustment);
};

// The values actually stored on healthProfile.activityLevel are the exact
// option labels a patient picks from (see docwellness-user's
// activityLevelOptions: 'Sedentary' / 'Lightly Activity' / 'Moderately
// Activity' / 'Very Active') - not the snake_case ACTIVITY_MULTIPLIERS keys
// above. Without this mapping, every lookup silently missed and fell back
// to the sedentary multiplier regardless of the patient's real activity
// level.
const ACTIVITY_LABEL_TO_KEY = {
  sedentary: 'sedentary',
  'lightly activity': 'lightly_active',
  'lightly active': 'lightly_active',
  'moderately activity': 'moderately_active',
  'moderately active': 'moderately_active',
  'very activity': 'very_active',
  'very active': 'very_active',
  'extra activity': 'extra_active',
  'extra active': 'extra_active',
};

const getActivityMultiplier = (activityLevel) => {
  if (!activityLevel) {
    return ACTIVITY_MULTIPLIERS.sedentary;
  }
  const key = ACTIVITY_LABEL_TO_KEY[String(activityLevel).trim().toLowerCase()];
  return ACTIVITY_MULTIPLIERS[key] || ACTIVITY_MULTIPLIERS.sedentary;
};

const calcTdee = (bmr, activityLevel) => {
  if (typeof bmr !== 'number' || Number.isNaN(bmr)) {
    return null;
  }
  const multiplier = getActivityMultiplier(activityLevel);
  return Math.round(bmr * multiplier);
};

/**
 * Deterministic protein target in grams/day from bodyweight, per the ISSN
 * 2017 Position Stand. Returns null for invalid weight rather than guessing.
 */
const calcProteinTargetG = ({ weightKg, isCaloricDeficit = false }) => {
  if (typeof weightKg !== 'number' || Number.isNaN(weightKg) || weightKg <= 0) {
    return null;
  }

  const band = isCaloricDeficit ? PROTEIN_G_PER_KG.deficit : PROTEIN_G_PER_KG.standard;
  const minG = Math.round(band.min * weightKg);
  const maxG = Math.round(band.max * weightKg);
  const recommendedG = Math.round(((band.min + band.max) / 2) * weightKg);

  return { minGPerKg: band.min, maxGPerKg: band.max, minG, maxG, recommendedG };
};

/**
 * Deterministic hydration guidance as a range (baseline + activity top-up),
 * not a false-precision single number - see WATER_ACTIVITY_EXTRA_L comment.
 */
const calcWaterTargetL = ({ weightKg, activityLevel }) => {
  if (typeof weightKg !== 'number' || Number.isNaN(weightKg) || weightKg <= 0) {
    return null;
  }

  const baselineL = (weightKg * 30) / 1000;
  const extraL = WATER_ACTIVITY_EXTRA_L[activityLevel] ?? WATER_ACTIVITY_EXTRA_L.sedentary;

  return {
    minL: Math.round(baselineL * 10) / 10,
    maxL: Math.round((baselineL + extraL) * 10) / 10,
  };
};

/**
 * Granular pre-activation status for the "New" tab's status box - walks the
 * same real fields the rest of the app already gates on (DietPlanRequest
 * .status/.plansCount and the patient's status.firstConsultationId/
 * .patientConsented - see patient_profile_view.dart's Unpaid sub-branches
 * and docwellness-user's Home _buildActionButton for the equivalent
 * patient-facing logic) instead of collapsing everything pre-payment into
 * a single "New Patient" bucket.
 */
const getNewTabStatusCode = ({
  plansCount,
  hasActivePlan,
  latestPaymentStatus,
  status,
  hasFirstConsultation = false,
  patientConsented = false,
}) => {
  if (status === 'Paid' || status === 'PartiallyPaid' || latestPaymentStatus === 'Paid') {
    return 6;
  }
  if (status === 'PaymentSubmitted' || latestPaymentStatus === 'Pending') {
    return 5;
  }
  if (status === 'PaymentRequested') {
    return 4;
  }
  if (status === 'Unpaid' && plansCount > 0) {
    return 3;
  }
  if (hasFirstConsultation && patientConsented) {
    return 2;
  }
  if (hasFirstConsultation) {
    return 1;
  }
  return 0;
};

const mapStatusCodeToLabel = (code) => STATUS_LABELS[code] || STATUS_LABELS[0];

module.exports = {
  ACTIVITY_MULTIPLIERS,
  STATUS_LABELS,
  PROTEIN_G_PER_KG,
  WATER_ACTIVITY_EXTRA_L,
  calcAge,
  calcBmr,
  getActivityMultiplier,
  calcTdee,
  calcProteinTargetG,
  calcWaterTargetL,
  getNewTabStatusCode,
  mapStatusCodeToLabel,
};
