/**
 * Adds a set of salad recipes, tagged tags:['salad'], for the "Recipes &
 * Supplements" screen's dedicated Salad section. Mirrors
 * add-side-dish-recipes.js's pattern - tags:['salad'] is orthogonal to
 * `category`/`servingTime`, so each salad still shows under its normal
 * cuisine/meal-time browsing too, on top of the new Salad shortcut.
 *
 * The base/main salad is explicitly grounded on raw cucumber + carrot per
 * the dietician's spec (fed via aiNote so it's authoritative, not
 * AI-invented); the rest add real variety.
 *
 * Usage:
 *   node scripts/add-salad-recipes.js            # dry run
 *   node scripts/add-salad-recipes.js --execute   # generate + create
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { generateRecipeWithAI } = require('../utils/openaiClient');
const {
  applyAiNoteQuantityOverrides,
  enforceFiniteIngredientQuantities,
} = require('../utils/ingredientQuantityValidator');
const { validateGeneratedIngredients } = require('../utils/dietaryConstraintValidator');

const EXECUTE = process.argv.includes('--execute');
const DIETICIAN_EMAIL = 'localdietician@dev.local';

const VALID_UNITS = ['g', 'ml', 'cup', 'tbsp', 'tsp', 'piece'];
const VALID_INGREDIENT_CATEGORIES = [
  'Protein Rich', 'Carbohydrate', 'Vegetable', 'Dairy', 'Spice', 'Oil/Fat',
  'Sweetener', 'Grain', 'Legume', 'Nut/Seed', 'Fruit', 'Herb',
  'Sauce/Condiment', 'Other',
];

const SALADS = [
  {
    name: 'Cucumber Carrot Salad',
    note: 'Main base salad: raw cucumber and raw carrot, both grated or thinly sliced, as the primary ingredients. Simple - lemon juice, a pinch of salt and pepper, optionally fresh coriander. No cooking, just assemble raw.',
  },
  {
    name: 'Kachumber Salad',
    note: 'Classic Indian kachumber: finely chopped raw cucumber, tomato, onion, and green chilli, tossed with lemon juice, salt, and fresh coriander. No cooking.',
  },
  {
    name: 'Koshimbir',
    note: 'Maharashtrian-style koshimbir: grated raw cucumber and carrot with a light tempering of mustard seeds and curry leaves in a little oil, mixed with roasted peanut powder and a touch of curd. Very light cooking (just the tempering).',
  },
  {
    name: 'Beetroot Salad',
    note: 'Grated or boiled and diced beetroot, tossed with lemon juice, a pinch of salt, and fresh coriander or mint. Minimal prep.',
  },
  {
    name: 'Sprouts Salad',
    note: 'Boiled moong sprouts mixed with finely chopped onion, tomato, cucumber, lemon juice, chaat masala, and fresh coriander. No cooking beyond boiling the sprouts briefly.',
  },
  {
    name: 'Mixed Vegetable Salad',
    note: 'A colorful raw salad of cucumber, carrot, tomato, bell pepper, and onion, all diced, tossed with lemon juice, olive oil, salt, and pepper. No cooking.',
  },
];

async function main() {
  console.log(EXECUTE ? '=== EXECUTING salad import ===' : '=== DRY RUN (pass --execute to generate + create) ===');

  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected.');

  try {
    const { User, Recipe } = require('../models');
    const dietician = await User.findOne({ email: DIETICIAN_EMAIL, role: 'dietician' });
    if (!dietician) throw new Error(`Dietician account not found: ${DIETICIAN_EMAIL}`);
    console.log(`Target dietician: ${dietician.profile?.fullName || dietician.email} (${dietician._id})`);

    const toProcess = [];
    for (const salad of SALADS) {
      const existing = await Recipe.findOne({
        dieticianId: dietician._id,
        name: new RegExp(`^${salad.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
      });
      if (existing) {
        console.log(`  [skip: already in DB] "${salad.name}"`);
        continue;
      }
      toProcess.push(salad);
    }

    console.log(`\n=== PLAN: ${toProcess.length} salad(s) ===`);
    toProcess.forEach((s, i) => console.log(`${i + 1}. "${s.name}"`));

    if (!EXECUTE) {
      console.log('\nThis was a dry run - no AI generation, no DB writes. Re-run with --execute to create these.');
      return;
    }

    let created = 0;
    let failed = 0;
    for (const salad of toProcess) {
      try {
        console.log(`\nGenerating: "${salad.name}"...`);
        const modelRecipe = await generateRecipeWithAI({
          name: salad.name,
          servingTime: 'Lunch',
          servings: 1,
          dietaryHabits: { vegetarian: true },
          freeFrom: {},
          aiNote: salad.note,
          languages: ['English', 'Hindi', 'Marathi'],
        });

        let ingredients = Array.isArray(modelRecipe.ingredients) ? modelRecipe.ingredients : [];
        const overrideResult = applyAiNoteQuantityOverrides({ aiNote: salad.note, ingredients, servings: 1 });
        ingredients = overrideResult.ingredients;
        const { ingredients: finiteIngredients, corrections } = enforceFiniteIngredientQuantities(ingredients);
        if (corrections.length > 0) {
          console.log(`  Quantity corrections: ${corrections.map((c) => `${c.ingredient} -> ${c.to.quantity}${c.to.unit}`).join(', ')}`);
        }

        const warnings = validateGeneratedIngredients({
          dietaryHabits: { vegetarian: true },
          freeFrom: {},
          ingredients: finiteIngredients,
        });
        if (warnings.length > 0) console.log(`  Warnings: ${warnings.join(' | ')}`);

        const safeIngredients = finiteIngredients.map((ing) => ({
          ...ing,
          unit: VALID_UNITS.includes(ing.unit) ? ing.unit : 'g',
          category: VALID_INGREDIENT_CATEGORIES.includes(ing.category) ? ing.category : 'Other',
        }));

        await Recipe.create({
          dieticianId: dietician._id,
          name: modelRecipe.name || salad.name,
          category: modelRecipe.category || 'Indian',
          cuisine: modelRecipe.cuisine || 'Indian',
          tags: ['salad'],
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

        created++;
        console.log(`  ✓ Created "${modelRecipe.name || salad.name}" [${modelRecipe.category}, tags: salad]`);
      } catch (err) {
        failed++;
        console.error(`  ✗ FAILED "${salad.name}": ${err.message}`);
      }
    }

    console.log(`\n=== DONE === Created: ${created}, Failed: ${failed}`);
  } catch (error) {
    console.error('Import failed:', error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB.');
  }
}

main();
