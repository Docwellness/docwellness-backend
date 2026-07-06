const ACTIVITY_MULTIPLIERS = {
  sedentary: 1.2,
  lightly_active: 1.375,
  moderately_active: 1.55,
  very_active: 1.725,
};

const STATUS_LABELS = {
  0: 'New Patient',
  1: 'Unpaid',
  2: 'Payment Pending',
  3: 'Paid',
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

const getActivityMultiplier = (activityLevel) => {
  if (!activityLevel) {
    return ACTIVITY_MULTIPLIERS.sedentary;
  }
  return ACTIVITY_MULTIPLIERS[activityLevel] || ACTIVITY_MULTIPLIERS.sedentary;
};

const calcTdee = (bmr, activityLevel) => {
  if (typeof bmr !== 'number' || Number.isNaN(bmr)) {
    return null;
  }
  const multiplier = getActivityMultiplier(activityLevel);
  return Math.round(bmr * multiplier);
};

const getNewTabStatusCode = ({ plansCount, hasActivePlan, latestPaymentStatus, status }) => {
  if (status === 'Paid' || latestPaymentStatus === 'Paid') {
    return 3;
  }
  if (
    status === 'PaymentSubmitted' ||
    status === 'PaymentRequested' ||
    latestPaymentStatus === 'Pending'
  ) {
    return 2;
  }
  if (status === 'Unpaid' && plansCount > 0) {
    return 1;
  }
  return 0;
};

const mapStatusCodeToLabel = (code) => STATUS_LABELS[code] || STATUS_LABELS[0];

module.exports = {
  ACTIVITY_MULTIPLIERS,
  STATUS_LABELS,
  calcAge,
  calcBmr,
  getActivityMultiplier,
  calcTdee,
  getNewTabStatusCode,
  mapStatusCodeToLabel,
};
