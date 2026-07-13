/**
 * Adds common side-dish accompaniments (Jowar Bhakri, Bajra Bhakri, Rice,
 * Chapati) as their own individual Recipe documents, tagged tags:['side'].
 *
 * These were previously only ever mentioned inline as part of a combo
 * dish's ingredient list during the earlier bulk import (e.g. "Matki Usal"
 * listing "Jowar/bajra bhakri - 1" as one of ITS ingredients) - meaning a
 * diet plan built purely from that combo recipe would never count the
 * bhakri's own calories separately. Giving each side its own Recipe entry
 * lets a diet plan add/count it independently.
 *
 * Tagging with tags:['side'] is orthogonal to `category` - each of these
 * keeps a normal cuisine category (Indian) and a normal servingTime
 * (Lunch), so they still show up under the regular Indian/Lunch browsing;
 * the tag only adds them to the dedicated Sides shortcut section on top of
 * that (see utils/recipeCategoryGroups.js's comment on this pattern).
 *
 * Uses the normal generateRecipeWithAI pipeline (these are real multi-
 * ingredient dishes with cooking steps, unlike the deterministic single-
 * ingredient supplements) - same quantity-override/finite-quantity/
 * dietary-warning post-processing as every other recipe.
 *
 * Usage:
 *   node scripts/add-side-dish-recipes.js            # dry run
 *   node scripts/add-side-dish-recipes.js --execute   # generate + create
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

const SIDES = [
  { name: 'Jowar Bhakri', note: 'Traditional Maharashtrian flatbread made from jowar (sorghum) flour, water, and a pinch of salt, patted by hand and cooked on a tawa. One bhakri, no oil/ghee.' },
  { name: 'Bajra Bhakri', note: 'Traditional Maharashtrian/Rajasthani flatbread made from bajra (pearl millet) flour, warm water, and a pinch of salt, patted by hand and cooked on a tawa. One bhakri, no oil/ghee.' },
  { name: 'Steamed Rice', note: 'Plain steamed white rice, cooked simply in water. One standard serving.' },
  { name: 'Chapati', note: 'Whole wheat flatbread (roti/phulka) made from atta, water, and a pinch of salt, rolled thin and cooked on a tawa, puffed over an open flame. One chapati, minimal oil/ghee.' },
];

async function main() {
  console.log(EXECUTE ? '=== EXECUTING side-dish import ===' : '=== DRY RUN (pass --execute to generate + create) ===');

  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected.');

  try {
    const { User, Recipe } = require('../models');
    const dietician = await User.findOne({ email: DIETICIAN_EMAIL, role: 'dietician' });
    if (!dietician) throw new Error(`Dietician account not found: ${DIETICIAN_EMAIL}`);
    console.log(`Target dietician: ${dietician.profile?.fullName || dietician.email} (${dietician._id})`);

    const toProcess = [];
    for (const side of SIDES) {
      const existing = await Recipe.findOne({
        dieticianId: dietician._id,
        name: new RegExp(`^${side.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
      });
      if (existing) {
        console.log(`  [skip: already in DB] "${side.name}"`);
        continue;
      }
      toProcess.push(side);
    }

    console.log(`\n=== PLAN: ${toProcess.length} side dish(es) ===`);
    toProcess.forEach((s, i) => console.log(`${i + 1}. "${s.name}"`));

    if (!EXECUTE) {
      console.log('\nThis was a dry run - no AI generation, no DB writes. Re-run with --execute to create these.');
      return;
    }

    let created = 0;
    let failed = 0;
    for (const side of toProcess) {
      try {
        console.log(`\nGenerating: "${side.name}"...`);
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

        created++;
        console.log(`  ✓ Created "${modelRecipe.name || side.name}" [${modelRecipe.category}, tags: side]`);
      } catch (err) {
        failed++;
        console.error(`  ✗ FAILED "${side.name}": ${err.message}`);
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
