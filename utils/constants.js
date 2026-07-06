// User roles
const USER_ROLES = {
  PATIENT: 'patient',
  DIETICIAN: 'dietician',
};

// Diet plan status
const DIET_PLAN_STATUS = {
  REQUESTED: 'Requested',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  ACTIVE: 'Active',
  COMPLETED: 'Completed',
};

// Meal types
const MEAL_TYPES = {
  BREAKFAST: 'Breakfast',
  LUNCH: 'Lunch',
  DINNER: 'Dinner',
  SNACK: 'Snack',
};

// Activity levels
const ACTIVITY_LEVELS = {
  SEDENTARY: 'Sedentary',
  LIGHTLY_ACTIVE: 'Lightly Active',
  MODERATELY_ACTIVE: 'Moderately Active',
  VERY_ACTIVE: 'Very Active',
};

// Health goals
const HEALTH_GOALS = {
  WEIGHT_LOSS: 'Weight Loss',
  WEIGHT_GAIN: 'Weight Gain',
  THYROID_CONTROL: 'Thyroid Control',
  PCOD_CONTROL: 'PCOD Control',
};

// Recipe categories
const RECIPE_CATEGORIES = {
  INDIAN: 'Indian',
  CONTINENTAL: 'Continental',
  FUSION: 'Fusion',
};

// Payment status
const PAYMENT_STATUS = {
  PENDING: 'Pending',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  REFUNDED: 'Refunded',
};

// Message types
const MESSAGE_TYPES = {
  TEXT: 'text',
  IMAGE: 'image',
  FILE: 'file',
};

// Notification types
const NOTIFICATION_TYPES = {
  DIET_PLAN: 'diet_plan',
  PAYMENT: 'payment',
  CHAT: 'chat',
  PROGRESS: 'progress',
  SYSTEM: 'system',
};

// Units for ingredients
const INGREDIENT_UNITS = {
  GRAM: 'g',
  MILLILITER: 'ml',
  CUP: 'cup',
  TABLESPOON: 'tbsp',
  TEASPOON: 'tsp',
  PIECE: 'piece',
};

// Genders
const GENDERS = {
  MALE: 'Male',
  FEMALE: 'Female',
  OTHER: 'Other',
};

module.exports = {
  USER_ROLES,
  DIET_PLAN_STATUS,
  MEAL_TYPES,
  ACTIVITY_LEVELS,
  HEALTH_GOALS,
  RECIPE_CATEGORIES,
  PAYMENT_STATUS,
  MESSAGE_TYPES,
  NOTIFICATION_TYPES,
  INGREDIENT_UNITS,
  GENDERS,
};
