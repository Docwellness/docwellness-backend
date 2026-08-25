/**
 * Fixes the two clean-trim cases found by
 * scripts/audit-cross-recipe-step-contamination.js: "Matki Usal" and "Veg
 * Usal" both have Jowar Bhakri's (and, for Matki Usal, a koshimbir salad's)
 * entire preparation baked into their own ingredients/instructions -
 * almost certainly from the original document-import pipeline not cleanly
 * splitting a combo meal's raw text per-dish. ("Varan" has the same
 * problem but far worse - see scripts/regenerate-varan-recipe.js instead.)
 *
 * For each recipe:
 *   - Drops the specific foreign ingredients (Jowar Flour, Cucumber,
 *     Carrot, Low-Fat Curd / Lemon - never touches Salt/Oil even though
 *     they sit near the foreign items in the list, since the recipe's own
 *     steps genuinely use them too).
 *   - Replaces `instructions` with just this dish's own steps, ending in a
 *     plain "Serve hot." instead of a cross-reference to another recipe.
 *   - Rewrites `description` to drop the "served with jowar bhakri/salad"
 *     clause.
 *   - Recomputes `nutrition` from real FoodItem data (same math as
 *     services/recipeVersioningService.js's computeNutritionFromIngredients)
 *     instead of leaving the old, now-wrong figure.
 *   - Regenerates Hindi/Marathi translations from the corrected English
 *     content via utils/openaiClient.js's generateTranslations, replacing
 *     the old (also contaminated) translations - safer than hand-editing
 *     existing Devanagari text.
 *
 * Recipe.save() triggers the existing post-save V1-sync hook automatically
 * - if this recipe is already prescribed to a patient, that plan keeps its
 * frozen old (contaminated) version; only a NEW plan generated after this
 * runs gets the corrected one. That's the existing, intentional freeze
 * behavior, not something this script manages itself.
 *
 * ALWAYS dry-run first (default) and read the diff before passing --execute.
 *
 * Usage:
 *   node scripts/correct-usal-recipe-contamination.js            # dry run
 *   node scripts/correct-usal-recipe-contamination.js --execute  # actually write
 */
require('dotenv').config();
const connectDB = require('../config/database');
const { normalize } = require('../utils/ingredientLibrary');
const { generateTranslations } = require('../utils/openaiClient');

const EXECUTE = process.argv.includes('--execute');
const NUTRITION_FIELDS = ['calories', 'protein', 'carbs', 'fats', 'fiber'];

const FIXES = [
  {
    recipeId: '6a50ef20d286aeeaeb756a00',
    name: 'Matki Usal',
    dropIngredients: ['Jowar Flour', 'Cucumber', 'Carrot', 'Low-Fat Curd'],
    instructions: [
      'Soak matki beans overnight and allow them to sprout for 1-2 days.',
      'Boil the sprouted matki until tender, then drain and set aside.',
      'In a pan, heat oil and add cumin seeds. Once they splutter, add chopped onions and sauté until golden brown.',
      'Add chopped tomatoes, green chili, turmeric powder, and salt. Cook until tomatoes are soft.',
      'Add the boiled matki to the pan and mix well. Cook for another 5 minutes, allowing flavors to meld.',
      'Serve hot.',
    ],
    description:
      'A traditional Maharashtrian dish of sprouted matki (moth beans) cooked with onions, tomatoes, and warming spices.',
  },
  {
    recipeId: '6a50ef7ad286aeeaeb756a72',
    name: 'Veg Usal',
    dropIngredients: ['Jowar Flour', 'Cucumber', 'Carrot', 'Lemon'],
    instructions: [
      'Soak the moong beans overnight or for at least 6 hours.',
      'Drain and rinse the moong beans. In a pot, add the beans with water and boil until tender.',
      'In a pan, heat oil and add cumin seeds. Once they splutter, add chopped onions, garlic, ginger, and green chili. Sauté until onions are translucent.',
      'Add chopped tomatoes, turmeric powder, and salt. Cook until tomatoes are soft.',
      'Add the boiled moong beans to the pan and mix well. Cook for another 5 minutes. Garnish with coriander leaves.',
      'Serve hot.',
    ],
    description:
      'A traditional Maharashtrian dish of light moong beans and vegetables simmered with warming spices.',
  },
];

async function computeNutrition(ingredients, FoodItem) {
  const normalizedNames = ingredients.map((i) => normalize(i.name));
  const foodItems = await FoodItem.find({ normalizedName: { $in: normalizedNames } });
  const foodItemsByNormalizedName = new Map(foodItems.map((f) => [f.normalizedName, f]));

  const totals = { calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0 };
  const unresolved = [];
  let anyResolved = false;

  for (const ingredient of ingredients) {
    const foodItem = foodItemsByNormalizedName.get(normalize(ingredient.name));
    const per100g = foodItem?.nutritionPer100g;
    const hasAllMacros = !!per100g && NUTRITION_FIELDS.every((f) => typeof per100g[f] === 'number');
    let grams = null;
    if (foodItem) {
      if (ingredient.unit === 'g') grams = ingredient.quantity;
      else if (typeof foodItem.unitConversions?.[ingredient.unit] === 'number') grams = ingredient.quantity * foodItem.unitConversions[ingredient.unit];
      else if (ingredient.unit === 'ml' && typeof foodItem.density === 'number') grams = ingredient.quantity * foodItem.density;
    }
    if (!foodItem || !hasAllMacros || grams === null) {
      unresolved.push(ingredient.name);
      continue;
    }
    anyResolved = true;
    for (const field of NUTRITION_FIELDS) totals[field] += (grams / 100) * per100g[field];
  }

  if (!anyResolved) return { nutrition: null, unresolved };
  const rounded = {};
  for (const field of NUTRITION_FIELDS) rounded[field] = Math.round(totals[field] * 10) / 10;
  return { nutrition: rounded, unresolved };
}

async function run() {
  await connectDB();
  try {
    const { Recipe, FoodItem } = require('../models');

    for (const fix of FIXES) {
      const recipe = await Recipe.findById(fix.recipeId);
      if (!recipe) {
        console.log(`No recipe found for id ${fix.recipeId} (${fix.name}) - skipping.`);
        continue;
      }

      const keptIngredients = recipe.ingredients.filter((i) => !fix.dropIngredients.includes(i.name));
      const droppedNames = recipe.ingredients.filter((i) => fix.dropIngredients.includes(i.name)).map((i) => i.name);

      console.log(`\n=== ${recipe.name} (${recipe._id}) ===`);
      console.log(`Dropping ingredients: ${droppedNames.join(', ') || '(none matched - check names!)'}`);
      console.log(`Kept ingredients: ${keptIngredients.map((i) => i.name).join(', ')}`);
      console.log(`Old instructions (${recipe.instructions.length}):`, recipe.instructions);
      console.log(`New instructions (${fix.instructions.length}):`, fix.instructions);
      console.log(`Old description: ${recipe.description}`);
      console.log(`New description: ${fix.description}`);

      const { nutrition, unresolved } = await computeNutrition(
        keptIngredients.map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unit })),
        FoodItem
      );
      console.log(`Old nutrition:`, recipe.nutrition);
      console.log(`Recomputed nutrition from real FoodItem data:`, nutrition, unresolved.length ? `(unresolved: ${unresolved.join(', ')})` : '');

      if (!EXECUTE) continue;

      recipe.ingredients = keptIngredients;
      recipe.instructions = fix.instructions;
      recipe.description = fix.description;
      if (nutrition) recipe.nutrition = nutrition;

      const languages = (recipe.language || []).filter((l) => l !== 'English');
      if (languages.length > 0) {
        const translations = await generateTranslations(
          { name: recipe.name, description: fix.description, ingredients: keptIngredients, cookingSteps: fix.instructions, warnings: [] },
          languages
        );
        for (const [lang, translation] of Object.entries(translations)) {
          recipe.translations.set(lang, translation);
        }
        console.log(`Regenerated translations for: ${Object.keys(translations).join(', ')}`);
      }

      await recipe.save();
      console.log('Saved.');
    }

    if (!EXECUTE) console.log('\nDry run only - pass --execute to apply.');
  } finally {
    await require('mongoose').disconnect();
  }
}

run().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
