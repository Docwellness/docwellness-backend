/**
 * Splits every recipe flagged by scripts/audit-side-bundled-recipe-names.js
 * (a main dish whose NAME bundles a side, e.g. "Bharli Vangi with Bhakri")
 * into two independent things:
 *
 *   1. The main recipe itself - renamed to just the dish (e.g. "Bharli
 *      Vangi"), with ingredients/cooking steps/nutrition regenerated via
 *      the same generateRecipeWithAI pipeline every other recipe here uses
 *      (see scripts/regenerate-varan-recipe.js for the identical single-
 *      recipe-regeneration pattern this mirrors), explicitly told to
 *      exclude the side. Preserves _id/dieticianId/category/cuisine/
 *      servingTime/servings/dietaryHabits/freeFrom/components exactly -
 *      only description/ingredients/instructions/nutrition/translations
 *      are replaced.
 *   2. The side (Chapati, Rice, Sambar, Chutney, Raita, ...) - reuses an
 *      existing tags:['side'] Recipe when one already covers it (see
 *      scripts/add-side-dish-recipes.js, which already created Chapati/
 *      Jowar Bhakri/Bajra Bhakri/Steamed Rice), or generates a new one the
 *      same way if not.
 *
 * No explicit main->side link is stored anywhere: services/
 * recipeSelectionEngine.js's selectMainAndAccompaniment already pairs ANY
 * main dish in a Lunch/Dinner slot with the best-scoring tags:['side']
 * recipe generically (see utils/dietPlanOptions.js's
 * SIDE_SALAD_ELIGIBLE_SLOTS) - splitting the side out into its own Recipe
 * document is all "wiring into the existing accompaniment mechanism" here
 * actually requires. Note that mechanism only ever attaches ONE
 * accompaniment per slot - a main that used to bundle two sides (e.g. Idli
 * "with Sambar and Chutney") will get paired with just one of them per
 * meal once split, not both simultaneously; extending the engine to
 * support multiple simultaneous accompaniments is out of scope here.
 *
 * Recipe.save() on the main triggers the existing post-save V1-sync hook
 * (models/Recipe.js) - freezes correctly (bumps to a new RecipeVersion
 * instead of mutating one already prescribed to a patient) exactly like
 * every other in-place recipe edit in this codebase.
 *
 * ALWAYS dry-run first (default) and read the plan before passing
 * --execute - this fires ~36 real AI generation calls and permanently
 * edits/creates shared catalog recipes.
 *
 * Usage:
 *   node scripts/split-main-and-side-recipes.js            # dry run
 *   node scripts/split-main-and-side-recipes.js --execute  # actually write
 */
require('dotenv').config();
const connectDB = require('../config/database');
const { generateRecipeWithAI } = require('../utils/openaiClient');
const {
  applyAiNoteQuantityOverrides,
  enforceFiniteIngredientQuantities,
} = require('../utils/ingredientQuantityValidator');
const { validateGeneratedIngredients } = require('../utils/dietaryConstraintValidator');

const EXECUTE = process.argv.includes('--execute');
const VALID_UNITS = ['g', 'ml', 'cup', 'tbsp', 'tsp', 'piece'];
const VALID_INGREDIENT_CATEGORIES = [
  'Protein Rich', 'Carbohydrate', 'Vegetable', 'Dairy', 'Spice', 'Oil/Fat',
  'Sweetener', 'Grain', 'Legume', 'Nut/Seed', 'Fruit', 'Herb',
  'Sauce/Condiment', 'Other',
];

// Every already-existing tags:['side'] recipe (see
// scripts/add-side-dish-recipes.js) that a main below reuses, keyed by the
// side name as it appears in MAIN_SPLITS[].sideRecipeName - avoids a
// near-duplicate catalog entry for the same physical side dish.
const EXISTING_SIDE_IDS = {
  Chapati: '6a51030e157263ca95ef5809',
  'Jowar Bhakri': '6a5102da157263ca95ef57e5',
  'Bajra Bhakri': '6a5102ea157263ca95ef57f1',
  'Steamed Rice': '6a5102fa157263ca95ef57fd',
};

// New side recipes this run needs to create (once) before any main can
// reference them - same generateRecipeWithAI + tags:['side'] pattern as
// scripts/add-side-dish-recipes.js.
const NEW_SIDES = [
  { name: 'Raita', note: 'Simple Indian raita - whisked low-fat curd/yogurt with grated cucumber, roasted cumin powder, and salt. One standard side bowl, no onion/garlic.' },
  { name: 'Curd', note: 'A plain small bowl of low-fat curd (dahi), served as a side alongside a main dish - not sweetened, no additions.' },
  { name: 'Whole Wheat Toast', note: 'One slice of whole wheat bread, lightly toasted. Minimal oil/butter.' },
  { name: 'Sambar', note: 'South Indian sambar - toor dal simmered with mixed vegetables (tomato, carrot, onion), tamarind, sambar powder, and a mustard-seed/curry-leaf tempering. One standard side bowl.' },
  { name: 'Coconut Chutney', note: 'South Indian coconut chutney - fresh grated coconut ground with green chilli, roasted chana dal/curry leaves, and a mustard-seed tempering. One standard side bowl.' },
  { name: 'Mint Chutney', note: 'Indian mint-coriander chutney - mint leaves and coriander leaves ground with green chilli, lemon juice, and a pinch of salt. One standard side condiment portion.' },
];

// The 30 main-dish recipes flagged by scripts/audit-side-bundled-recipe-names.js
// as bundling a side into their own name/ingredients - see that script's
// output (side-bundled-recipe-audit.json) for the full per-recipe
// ingredient lists this was triaged from.
const MAIN_SPLITS = [
  { id: '6a8de40c727c939296a81df4', mainName: 'Palak Paneer', excludeNote: 'Chapati (or any roti/flatbread)', sideRecipeName: 'Chapati' },
  { id: '6a8de40c727c939296a81e00', mainName: 'Gobi Matar', excludeNote: 'Chapati (or any roti/flatbread)', sideRecipeName: 'Chapati' },
  { id: '6a8de40e727c939296a81e4e', mainName: 'Dal Palak', excludeNote: 'Chapati (or any roti/flatbread)', sideRecipeName: 'Chapati' },
  { id: '6a8de40f727c939296a81eb3', mainName: 'Tofu Bhurji', excludeNote: 'Chapati (or any roti/flatbread)', sideRecipeName: 'Chapati' },
  { id: '6a8de410727c939296a81edb', mainName: 'Bharwan Shimla Mirch', excludeNote: 'Chapati (or any roti/flatbread)', sideRecipeName: 'Chapati' },
  { id: '6a8de410727c939296a81ee1', mainName: 'Turai Sabji', excludeNote: 'Chapati (or any roti/flatbread)', sideRecipeName: 'Chapati' },
  { id: '6a8de40e727c939296a81e54', mainName: 'Vegetable Korma', excludeNote: 'Pulka/Chapati (or any roti/flatbread)', sideRecipeName: 'Chapati' },

  { id: '6a8de40c727c939296a81dfa', mainName: 'Bhindi Sabji', excludeNote: 'Jowar Bhakri (or any flatbread)', sideRecipeName: 'Jowar Bhakri' },
  { id: '6a8de410727c939296a81eb9', mainName: 'Methi Dal', excludeNote: 'Jowar Bhakri (or any flatbread)', sideRecipeName: 'Jowar Bhakri' },

  { id: '6a8de40d727c939296a81e12', mainName: 'Egg Bhurji', excludeNote: 'Bhakri (bajra flatbread)', sideRecipeName: 'Bajra Bhakri' },
  { id: '6a8de40e727c939296a81e5a', mainName: 'Bharli Vangi', excludeNote: 'Bhakri (bajra flatbread)', sideRecipeName: 'Bajra Bhakri' },

  { id: '6a8de40c727c939296a81dee', mainName: 'Dal Tadka', excludeNote: 'steamed rice', sideRecipeName: 'Steamed Rice' },
  { id: '6a8de40c727c939296a81e0c', mainName: 'Kerala Fish Curry', excludeNote: 'steamed rice', sideRecipeName: 'Steamed Rice' },
  { id: '6a8de40d727c939296a81e18', mainName: 'Chana Dal', excludeNote: 'steamed rice', sideRecipeName: 'Steamed Rice' },
  { id: '6a8de40d727c939296a81e24', mainName: 'Whole Masoor Dal', excludeNote: 'steamed rice', sideRecipeName: 'Steamed Rice' },
  { id: '6a8de40d727c939296a81e48', mainName: 'Kala Chana Curry', excludeNote: 'steamed rice', sideRecipeName: 'Steamed Rice' },
  { id: '6a8de40f727c939296a81ea8', mainName: 'Palak Dal', excludeNote: 'steamed rice', sideRecipeName: 'Steamed Rice' },
  { id: '6a8de410727c939296a81ed0', mainName: 'Masoor Dal', excludeNote: 'steamed rice', sideRecipeName: 'Steamed Rice' },
  { id: '6a8da11b0ebafe80ec36cd44', mainName: 'Thai Vegetable Curry', excludeNote: 'steamed rice', sideRecipeName: 'Steamed Rice' },
  { id: '6a8da1770ebafe80ec36cdc2', mainName: 'Japanese Miso Vegetable Soup', excludeNote: 'steamed rice', sideRecipeName: 'Steamed Rice' },

  { id: '6a8de40d727c939296a81e1e', mainName: 'Vegetable Biryani', excludeNote: 'raita (curd/cucumber side)', sideRecipeName: 'Raita' },
  { id: '6a8de40a727c939296a81d74', mainName: 'Methi Thepla', excludeNote: 'a side bowl of curd/yogurt', sideRecipeName: 'Curd' },
  { id: '6a8de40b727c939296a81da0', mainName: 'Egg Salad', excludeNote: 'whole wheat toast/bread', sideRecipeName: 'Whole Wheat Toast' },
  { id: '6a8de40f727c939296a81eae', mainName: 'Vegetable Soup', excludeNote: 'whole wheat toast/bread', sideRecipeName: 'Whole Wheat Toast' },

  { id: '6a50ec49d286aeeaeb756724', mainName: 'Idli', excludeNote: 'sambar and chutney', sideRecipeName: 'Sambar' },
  { id: '6a50ee8cd286aeeaeb756970', mainName: 'Onion Uttapa', excludeNote: 'sambar and chutney', sideRecipeName: 'Sambar' },
  { id: '6a8da0160ebafe80ec36cc60', mainName: 'Ragi Idli', excludeNote: 'coconut chutney', sideRecipeName: 'Coconut Chutney' },
  { id: '6a8de40a727c939296a81d67', mainName: 'Ragi Dosa', excludeNote: 'coconut chutney', sideRecipeName: 'Coconut Chutney' },
  { id: '6a8de40a727c939296a81d7f', mainName: 'Rava Idli', excludeNote: 'coconut chutney', sideRecipeName: 'Coconut Chutney' },
  { id: '6a8de40a727c939296a81d9b', mainName: 'Grilled Paneer Sandwich', excludeNote: 'mint chutney', sideRecipeName: 'Mint Chutney' },
];

async function findDietician() {
  const { User } = require('../models');
  // Every flagged recipe already belongs to this same dieticianId (see
  // side-bundled-recipe-audit.json) - reuse it for any newly-created side
  // recipe too, rather than a separate hardcoded account.
  const dietician = await User.findById('6a5e0c3619fa51068811c304');
  if (!dietician) throw new Error('Expected dietician 6a5e0c3619fa51068811c304 not found');
  return dietician;
}

async function createSideIfMissing(side, dietician, cache) {
  const { Recipe } = require('../models');
  if (EXISTING_SIDE_IDS[side.name]) {
    cache[side.name] = EXISTING_SIDE_IDS[side.name];
    return { name: side.name, id: EXISTING_SIDE_IDS[side.name], created: false };
  }
  if (cache[side.name]) return { name: side.name, id: cache[side.name], created: false };

  const existing = await Recipe.findOne({
    dieticianId: dietician._id,
    name: new RegExp(`^${side.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
  });
  if (existing) {
    cache[side.name] = String(existing._id);
    return { name: side.name, id: String(existing._id), created: false };
  }

  if (!EXECUTE) {
    console.log(`  [would create side] "${side.name}" - ${side.note}`);
    return { name: side.name, id: null, created: false };
  }

  console.log(`  Generating side: "${side.name}"...`);
  const modelRecipe = await generateRecipeWithAI({
    name: side.name,
    servingTime: 'Lunch',
    servings: 1,
    dietaryHabits: { vegetarian: true },
    freeFrom: {},
    aiNote: side.note,
    languages: ['English', 'Hindi', 'Marathi'],
  });

  let ingredients = Array.isArray(modelRecipe.ingredients) ? modelRecipe.ingredients : [];
  const overrideResult = applyAiNoteQuantityOverrides({ aiNote: side.note, ingredients, servings: 1 });
  ingredients = overrideResult.ingredients;
  const { ingredients: finiteIngredients } = enforceFiniteIngredientQuantities(ingredients);
  validateGeneratedIngredients({ dietaryHabits: { vegetarian: true }, freeFrom: {}, ingredients: finiteIngredients });

  const safeIngredients = finiteIngredients.map((ing) => ({
    ...ing,
    unit: VALID_UNITS.includes(ing.unit) ? ing.unit : 'g',
    category: VALID_INGREDIENT_CATEGORIES.includes(ing.category) ? ing.category : 'Other',
  }));

  const created = await Recipe.create({
    dieticianId: dietician._id,
    name: modelRecipe.name || side.name,
    category: modelRecipe.category || 'Indian',
    cuisine: modelRecipe.cuisine || 'Indian',
    tags: ['side'],
    description: modelRecipe.description || '',
    servingTime: 'Lunch',
    servings: 1,
    preparationTime: modelRecipe.preparationTime,
    cookingTime: modelRecipe.cookingTime,
    dietaryHabits: { vegetarian: true },
    freeFrom: {},
    servingSize: modelRecipe.servingSize,
    ingredients: safeIngredients,
    instructions: modelRecipe.cookingSteps || [],
    nutrition: modelRecipe.nutrition,
    language: ['English', 'Hindi', 'Marathi'],
    translations: modelRecipe.translations || {},
  });
  console.log(`  ✓ Created side "${created.name}" [${created._id}]`);
  cache[side.name] = String(created._id);
  return { name: side.name, id: String(created._id), created: true };
}

async function splitMain(spec, dietician) {
  const { Recipe } = require('../models');
  const recipe = await Recipe.findById(spec.id);
  if (!recipe) {
    console.log(`  ✗ SKIP - recipe ${spec.id} not found (expected "${spec.mainName}")`);
    return { ok: false };
  }

  console.log(`\n"${recipe.name}" [${recipe._id}]`);
  console.log(`  -> rename to: "${spec.mainName}"`);
  console.log(`  -> exclude: ${spec.excludeNote} (now its own side recipe: "${spec.sideRecipeName}")`);
  console.log(`  current ingredients: ${recipe.ingredients.map((i) => i.name).join(', ')}`);

  if (!EXECUTE) return { ok: true };

  const languages = recipe.language && recipe.language.length > 0 ? recipe.language : ['English'];
  const generated = await generateRecipeWithAI({
    name: spec.mainName,
    servingTime: recipe.servingTime,
    servings: recipe.servings,
    dietaryHabits: recipe.dietaryHabits,
    freeFrom: recipe.freeFrom,
    aiNote: `Only the ${spec.mainName} itself - do NOT include ${spec.excludeNote}. That is a separate side dish served alongside it, not part of this recipe - do not mention it in the ingredients or cooking steps.`,
    languages,
  });

  let ingredients = Array.isArray(generated.ingredients) ? generated.ingredients : [];
  const { ingredients: finiteIngredients } = enforceFiniteIngredientQuantities(ingredients);
  const safeIngredients = finiteIngredients.map((ing) => ({
    ...ing,
    unit: VALID_UNITS.includes(ing.unit) ? ing.unit : 'g',
    category: VALID_INGREDIENT_CATEGORIES.includes(ing.category) ? ing.category : 'Other',
  }));

  recipe.name = generated.name || spec.mainName;
  recipe.description = generated.description;
  recipe.ingredients = safeIngredients;
  recipe.instructions = generated.cookingSteps;
  recipe.nutrition = generated.nutrition;
  // category/cuisine/servingTime/servings/dietaryHabits/freeFrom/components
  // deliberately left untouched - see regenerate-varan-recipe.js's identical
  // rationale (this is a content fix, not a full re-author).
  if (generated.translations) {
    for (const [lang, translation] of Object.entries(generated.translations)) {
      recipe.translations.set(lang, translation);
    }
  }

  await recipe.save();
  console.log(`  ✓ Saved "${recipe.name}" - new ingredients: ${recipe.ingredients.map((i) => i.name).join(', ')}`);
  console.log(`    new nutrition: ${JSON.stringify(recipe.nutrition)}`);
  return { ok: true };
}

async function main() {
  console.log(EXECUTE ? '=== EXECUTING main/side split ===' : '=== DRY RUN (pass --execute to generate + write) ===');
  await connectDB();
  try {
    const dietician = await findDietician();
    console.log(`Dietician: ${dietician.profile?.fullName || dietician.email} (${dietician._id})\n`);

    console.log(`=== Side recipes (${NEW_SIDES.length} potentially new, ${Object.keys(EXISTING_SIDE_IDS).length} reused) ===`);
    const sideCache = {};
    for (const side of NEW_SIDES) {
      await createSideIfMissing(side, dietician, sideCache);
    }

    console.log(`\n=== Main recipes (${MAIN_SPLITS.length}) ===`);
    let ok = 0;
    let failed = 0;
    for (const spec of MAIN_SPLITS) {
      try {
        const result = await splitMain(spec, dietician);
        if (result.ok) ok++;
        else failed++;
      } catch (err) {
        failed++;
        console.error(`  ✗ FAILED "${spec.mainName}" (${spec.id}): ${err.message}`);
      }
    }

    console.log(`\n=== DONE === OK: ${ok}, Failed: ${failed}`);
    if (!EXECUTE) console.log('\nThis was a dry run - no AI generation, no DB writes. Re-run with --execute to apply.');
  } finally {
    await require('mongoose').disconnect();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
