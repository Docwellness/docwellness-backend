// Deterministic dietary-constraint checks that run before/after the AI recipe
// prompt, so contradictory input (e.g. Jain + Garlic) is rejected with a clear
// error instead of being silently handed to the LLM as conflicting instructions.

const DIET_RULES = {
  vegan: {
    label: 'Vegan',
    excludes: [
      'milk', 'dairy', 'paneer', 'cheese', 'curd', 'yogurt', 'yoghurt', 'ghee',
      'butter', 'cream', 'honey', 'egg', 'eggs', 'chicken', 'mutton', 'lamb',
      'beef', 'pork', 'fish', 'prawn', 'shrimp', 'crab', 'meat', 'gelatin',
      'mayonnaise', 'khoya', 'malai',
    ],
  },
  jain: {
    label: 'Jain',
    excludes: [
      'garlic', 'onion', 'potato', 'potatoes', 'sweet potato', 'ginger',
      'carrot', 'radish', 'beetroot', 'beet', 'mushroom', 'spring onion',
      'leek', 'shallot', 'yam', 'turnip',
    ],
  },
  vegetarian: {
    label: 'Vegetarian',
    excludes: [
      'chicken', 'mutton', 'lamb', 'beef', 'pork', 'fish', 'prawn', 'shrimp',
      'crab', 'meat', 'egg', 'eggs', 'gelatin', 'anchovy',
    ],
  },
  eggitarian: {
    label: 'Eggetarian',
    excludes: [
      'chicken', 'mutton', 'lamb', 'beef', 'pork', 'fish', 'prawn', 'shrimp',
      'crab', 'meat', 'gelatin', 'anchovy',
    ],
  },
  // Non-Vegetarian is the most permissive category - nothing to exclude.
  nonVegetarian: { label: 'Non-Vegetarian', excludes: [] },
};

const FREE_FROM_RULES = {
  sugar: {
    label: 'Sugar-free',
    excludes: ['sugar', 'jaggery', 'honey', 'syrup', 'brown sugar', 'powdered sugar', 'castor sugar'],
  },
  salt: {
    label: 'Salt-free',
    excludes: ['salt', 'soy sauce', 'soya sauce', 'pickle', 'papad'],
  },
  processedFood: {
    label: 'No processed ingredients',
    excludes: ['ketchup', 'mayonnaise', 'instant noodles', 'canned', 'packaged', 'processed cheese', 'soda', 'maida'],
  },
  oil: {
    label: 'Oil-free',
    excludes: ['oil', 'ghee', 'butter', 'margarine'],
  },
};

// Base categories represent the recipe's animal-product permissiveness and
// are mutually exclusive - a recipe can't be both Vegan and Non-Vegetarian.
// Jain is a separate axis (no onion/garlic/root veg) layered on top of
// Vegan/Vegetarian, but incompatible with Eggetarian/Non-Vegetarian.
const BASE_DIET_FLAGS = ['vegan', 'vegetarian', 'nonVegetarian', 'eggitarian'];
const JAIN_INCOMPATIBLE_FLAGS = ['nonVegetarian', 'eggitarian'];

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsKeyword(text, keyword) {
  const pattern = new RegExp(`\\b${escapeRegExp(keyword)}\\b`, 'i');
  return pattern.test(text);
}

/** Checks the selected dietaryHabits flags for internally contradictory combinations. */
function checkDietMutualExclusivity(dietaryHabits) {
  const errors = [];
  if (!dietaryHabits) return errors;

  const activeBase = BASE_DIET_FLAGS.filter((flag) => dietaryHabits[flag]);
  if (activeBase.length > 1) {
    const labels = activeBase.map((flag) => DIET_RULES[flag].label).join(', ');
    errors.push(`Conflicting dietary habits selected: ${labels} cannot all apply to the same recipe.`);
  }

  if (dietaryHabits.jain) {
    const conflicting = JAIN_INCOMPATIBLE_FLAGS.filter((flag) => dietaryHabits[flag]);
    if (conflicting.length > 0) {
      const labels = conflicting.map((flag) => DIET_RULES[flag].label).join(', ');
      errors.push(`Jain cannot be combined with ${labels} - Jain is a strict vegetarian diet.`);
    }
  }

  return errors;
}

/**
 * Scans free-text (custom ingredients/preferences, or a joined list of
 * ingredient names) for words that conflict with the active dietary habits
 * and free-from flags.
 * Returns an array of { flag, ruleLabel, keyword } conflict records.
 */
function findIngredientConflicts({ dietaryHabits, freeFrom, text }) {
  const conflicts = [];
  if (!text || !text.trim()) return conflicts;

  for (const [flag, rule] of Object.entries(DIET_RULES)) {
    if (!dietaryHabits?.[flag]) continue;
    for (const keyword of rule.excludes) {
      if (containsKeyword(text, keyword)) {
        conflicts.push({ flag, ruleLabel: rule.label, keyword });
      }
    }
  }

  for (const [flag, rule] of Object.entries(FREE_FROM_RULES)) {
    if (!freeFrom?.[flag]) continue;
    for (const keyword of rule.excludes) {
      if (containsKeyword(text, keyword)) {
        conflicts.push({ flag, ruleLabel: rule.label, keyword });
      }
    }
  }

  return conflicts;
}

/**
 * Pre-check run before the AI prompt is built. Validates the dietary habit
 * combination itself, and cross-checks the dietician's free-text custom
 * ingredients/preferences (aiNote) against the active restrictions.
 */
function validateRecipeConstraints({ dietaryHabits, freeFrom, aiNote }) {
  const errors = [...checkDietMutualExclusivity(dietaryHabits)];

  const conflicts = findIngredientConflicts({ dietaryHabits, freeFrom, text: aiNote });
  for (const conflict of conflicts) {
    errors.push(
      `Custom Ingredients/Preferences mentions "${conflict.keyword}", which is not allowed for the ${conflict.ruleLabel} restriction.`
    );
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Post-check run on the AI's returned ingredient list, as a defense-in-depth
 * catch for cases where the model didn't fully honor the prompt's dietary
 * restrictions. Returns human-readable warning strings (non-blocking).
 */
function validateGeneratedIngredients({ dietaryHabits, freeFrom, ingredients }) {
  if (!Array.isArray(ingredients) || ingredients.length === 0) return [];

  const text = ingredients.map((ing) => ing?.name || '').join(', ');
  const conflicts = findIngredientConflicts({ dietaryHabits, freeFrom, text });

  return conflicts.map(
    (conflict) =>
      `⚠ Constraint violation: this recipe includes "${conflict.keyword}", which conflicts with the ${conflict.ruleLabel} restriction. Please review before saving.`
  );
}

// Most-restrictive-wins precedence, matching the app's dietary habit toggles
// (Jain > Vegan > Vegetarian > Eggetarian > Non-Vegetarian). Consultation
// intake options are free-text (dietician-configurable form), so this maps
// common label variants onto the Recipe.dietaryHabits boolean keys rather
// than assuming a fixed enum.
const EATING_STYLE_ALIASES = {
  jain: ['jain'],
  vegan: ['vegan'],
  vegetarian: ['vegetarian', 'veg'],
  eggitarian: ['eggetarian', 'eggitarian', 'egg-etarian', 'ovo-vegetarian'],
  nonVegetarian: ['non-vegetarian', 'non vegetarian', 'nonvegetarian', 'non-veg', 'non veg'],
};

/**
 * Maps a patient's free-text "current eating style" consultation options to
 * the single most-restrictive Recipe.dietaryHabits flag that should be used
 * as a hard filter when selecting recipes for a diet plan. Returns null when
 * no recognizable option is present (callers should then skip filtering
 * rather than block generation on unrelated/custom intake wording).
 */
function mapEatingStyleToDietFlag(options) {
  if (!Array.isArray(options) || options.length === 0) return null;

  const normalized = options
    .map((option) => (option || '').toString().trim().toLowerCase())
    .filter(Boolean);
  if (normalized.length === 0) return null;

  const matches = (flag) => EATING_STYLE_ALIASES[flag].some((alias) => normalized.includes(alias));

  if (matches('jain')) return 'jain';
  if (matches('vegan')) return 'vegan';
  if (matches('vegetarian')) return 'vegetarian';
  if (matches('eggitarian')) return 'eggitarian';
  if (matches('nonVegetarian')) return 'nonVegetarian';
  return null;
}

const normalizeAllergyKeyword = (term) => term.trim().toLowerCase().replace(/s$/, '');

// The consultation form's `diet_allergies_intolerances` field (see
// utils/consultationFormSeed.js's SAFETY_FIELD_IDS.ALLERGIES) presents broad
// category labels, not ingredient names - a plain substring match against
// the label itself ("dairy / lactose", "gluten", "seafood") almost never
// matches a real ingredient name ("Milk", "Wheat flour", "Fish"), silently
// letting those allergens through. Expands each category into the specific
// ingredient-name keywords a patient would actually expect excluded.
// Over-inclusive by design, matching this function's existing philosophy
// (see doc comment below) - a false-positive exclusion just removes one
// recipe from the AI's pool, a false negative could serve an allergen.
const ALLERGY_CATEGORY_KEYWORDS = {
  gluten: ['gluten', 'wheat', 'atta', 'maida', 'rava', 'semolina', 'suji', 'barley', 'rye', 'bread', 'bulgur', 'couscous', 'vermicelli', 'noodle', 'pasta', 'chapati', 'paratha', 'naan', 'poori', 'puri'],
  'dairy / lactose': ['dairy', 'milk', 'paneer', 'curd', 'yogurt', 'yoghurt', 'cheese', 'ghee', 'butter', 'cream', 'khoya', 'lassi', 'buttermilk', 'whey'],
  nuts: ['nut', 'almond', 'cashew', 'pistachio', 'hazelnut', 'walnut', 'peanut', 'macadamia', 'pecan', 'pine nut'],
  seafood: ['fish', 'prawn', 'shrimp', 'crab', 'lobster', 'squid', 'octopus', 'oyster', 'mussel', 'clam', 'salmon', 'tuna', 'sardine', 'seafood'],
  eggs: ['egg'],
  soy: ['soy', 'soya', 'tofu', 'edamame'],
  sesame: ['sesame', 'til', 'tahini'],
};

/**
 * Keyword-based allergen/foods-to-avoid scan: compares a recipe's ingredient
 * names against the patient's consultation-stated allergies/intolerances and
 * "foods to avoid" free text. This is a substring heuristic (not a clinical
 * allergen taxonomy) - it's deliberately conservative so it over-flags rather
 * than misses, and is meant to exclude/flag candidates before the AI ever
 * sees them, not to replace the dietician's own review.
 */
function findAllergenConflicts({ ingredients, allergyOptions = [], allergyOtherInfo = '', foodsToAvoidText = '' }) {
  const freeText = [allergyOtherInfo, foodsToAvoidText].filter(Boolean).join(', ');
  const expandedAllergyOptions = (Array.isArray(allergyOptions) ? allergyOptions : []).flatMap((option) => {
    const category = ALLERGY_CATEGORY_KEYWORDS[option.trim().toLowerCase()];
    return category ? [option, ...category] : [option];
  });
  const keywords = [...expandedAllergyOptions, ...freeText.split(/[,.;\n]| and /i)]
    .map(normalizeAllergyKeyword)
    .filter((keyword) => keyword.length > 2);

  if (keywords.length === 0) return [];

  const ingredientNames = Array.isArray(ingredients)
    ? ingredients.map((ingredient) => (typeof ingredient === 'string' ? ingredient : ingredient?.name || ''))
    : [];

  const conflicts = [];
  for (const ingredientName of ingredientNames) {
    if (!ingredientName) continue;
    const normalizedIngredient = normalizeAllergyKeyword(ingredientName);
    for (const keyword of keywords) {
      if (normalizedIngredient.includes(keyword) || keyword.includes(normalizedIngredient)) {
        conflicts.push({ ingredient: ingredientName, keyword });
      }
    }
  }
  return conflicts;
}

/**
 * Looks up a single answer's value from a FirstConsultation.customAnswers
 * array by fieldId. Used to read the dietary-safety-critical answers (eating
 * style, allergies, foods to avoid) collected via the dynamic consultation
 * form - see utils/consultationFormSeed.js's SAFETY_FIELD_IDS for the stable
 * fieldIds this is called with.
 */
function getConsultationAnswer(customAnswers, fieldId) {
  if (!Array.isArray(customAnswers)) return undefined;
  return customAnswers.find((a) => a?.fieldId === fieldId)?.value;
}

module.exports = {
  DIET_RULES,
  FREE_FROM_RULES,
  checkDietMutualExclusivity,
  findIngredientConflicts,
  validateRecipeConstraints,
  validateGeneratedIngredients,
  mapEatingStyleToDietFlag,
  findAllergenConflicts,
  getConsultationAnswer,
};
