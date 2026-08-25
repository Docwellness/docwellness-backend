/**
 * Adds recipes to fill out the thinnest meal slots (Brunch, Night Drink) and
 * add cuisine variety to Lunch (currently ~18/23 'Indian'), for dietician
 * tejasvini@docwellness.fit - see openspec/changes/recipe-database-ayurveda-expansion.
 *
 * Mirrors scripts/add-salad-recipes.js exactly: generateRecipeWithAI ->
 * applyAiNoteQuantityOverrides -> enforceFiniteIngredientQuantities ->
 * validateGeneratedIngredients -> Recipe.create(). No hand-rolled nutrition
 * table, no direct RecipeVersion writes - Recipe.create() triggers the
 * existing post-save V1-sync hook.
 *
 * Each candidate's note explicitly tells the AI to avoid the Viruddha
 * Aahara patterns found in the audit (meat+dairy, heated curd/honey,
 * milk+sour-fruit). A post-generation keyword check additionally logs a
 * non-blocking warning if a generated recipe still matches one of those
 * patterns, for dietician review - it never blocks creation.
 *
 * Usage:
 *   node scripts/add-slot-coverage-recipes.js            # dry run
 *   node scripts/add-slot-coverage-recipes.js --execute   # generate + create
 */

require('dotenv').config();
require('dns').setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');
const { generateRecipeWithAI } = require('../utils/openaiClient');
const {
  applyAiNoteQuantityOverrides,
  enforceFiniteIngredientQuantities,
} = require('../utils/ingredientQuantityValidator');
const { validateGeneratedIngredients } = require('../utils/dietaryConstraintValidator');

const EXECUTE = process.argv.includes('--execute');
const DIETICIAN_EMAIL = 'tejasvini@docwellness.fit';

const VALID_UNITS = ['g', 'ml', 'cup', 'tbsp', 'tsp', 'piece'];
const VALID_INGREDIENT_CATEGORIES = [
  'Protein Rich', 'Carbohydrate', 'Vegetable', 'Dairy', 'Spice', 'Oil/Fat',
  'Sweetener', 'Grain', 'Legume', 'Nut/Seed', 'Fruit', 'Herb',
  'Sauce/Condiment', 'Other',
];

const VIRUDDHA_NOTE_SUFFIX =
  ' Ayurveda note: do not combine meat/egg with curd/yogurt or milk, do not cook/heat curd or honey ' +
  '(add them raw/cool or off heat if used at all), and do not combine milk with sour fruit (lemon, ' +
  'orange, pineapple, tamarind).';

const CANDIDATES = [
  // Brunch (thinnest slot at 7 existing recipes)
  { name: 'Sabudana Khichdi', servingTime: 'Brunch', category: 'Indian',
    note: 'Classic Maharashtrian sabudana khichdi: soaked tapioca pearls tempered with cumin, peanuts, and green chilli in a little oil, finished with lemon juice and coriander. Light cooking (tempering + steaming the pearls).' },
  { name: 'Vegetable Sandwich', servingTime: 'Brunch', category: 'Continental',
    note: 'Whole wheat bread sandwich with cucumber, tomato, onion, and lettuce, a light spread of mint chutney, salt and pepper. No cooking, just assemble.' },
  { name: 'Ragi Idli with Coconut Chutney', servingTime: 'Brunch', category: 'Indian',
    note: 'Steamed ragi (finger millet) idlis served with a coconut-coriander chutney tempered with mustard seeds and curry leaves. Steamed, minimal oil.' },
  { name: 'Corn Chaat', servingTime: 'Brunch', category: 'Indian',
    note: 'Boiled sweet corn tossed with onion, tomato, lemon juice, chaat masala, and coriander leaves. No cooking beyond boiling the corn.' },
  { name: 'Baked Sweet Potato Chaat', servingTime: 'Brunch', category: 'Indian',
    note: 'Cubed sweet potato roasted/baked with a little oil, tossed with chaat masala, lemon juice, and coriander leaves.' },
  { name: 'Roasted Foxnut Trail Mix', servingTime: 'Brunch', category: 'Healthy Bowls',
    note: 'Roasted makhana (foxnuts), almonds, and pumpkin seeds lightly roasted in a touch of oil with black pepper and rock salt. Dry roasting only.' },

  // Night Drink (thinnest tied with Evening Snack at 8 existing)
  { name: 'Chamomile Tea', servingTime: 'Night Drink', category: 'Other',
    note: 'Dried chamomile flowers steeped in hot water for a calming bedtime drink. Simple infusion, no dairy.' },
  { name: 'Ashwagandha Milk', servingTime: 'Night Drink', category: 'Indian',
    note: 'Warm milk with ashwagandha powder and a pinch of nutmeg, gently warmed (not boiled hard). No fruit and no honey added while hot - if honey is used at all, note it must be stirred in only after the milk has cooled slightly.' },
  { name: 'Saffron Milk', servingTime: 'Night Drink', category: 'Indian',
    note: 'Warm milk infused with a few strands of saffron and a pinch of cardamom. No fruit, no honey added while hot.' },
  { name: 'Warm Amla Water', servingTime: 'Night Drink', category: 'Detox',
    note: 'Warm water with a spoon of amla (Indian gooseberry) juice, no dairy, no honey added while hot.' },
  { name: 'Licorice Tea', servingTime: 'Night Drink', category: 'Other',
    note: 'Licorice root steeped in hot water, a simple calming infusion, no dairy.' },
  { name: 'Nutmeg Milk', servingTime: 'Night Drink', category: 'Indian',
    note: 'Warm milk with a pinch of grated nutmeg, gently warmed (not boiled hard). No fruit, no honey added while hot.' },

  // Lunch cuisine variety (numerically fine at 23, but ~18/23 are 'Indian')
  { name: 'Mediterranean Chickpea Bowl', servingTime: 'Lunch', category: 'Mediterranean',
    note: 'Boiled chickpeas, cucumber, tomato, red onion, and olives tossed with olive oil, lemon juice, and parsley, served over a small portion of couscous. No dairy.' },
  { name: 'Thai Vegetable Curry with Rice', servingTime: 'Lunch', category: 'Thai',
    note: 'Mixed vegetables (bell pepper, carrot, green beans, broccoli) simmered in a light coconut-milk based Thai curry with basil and lime, served over steamed rice. No dairy other than coconut milk.' },
  { name: 'Mexican Black Bean Bowl', servingTime: 'Lunch', category: 'Mexican',
    note: 'Boiled black beans, corn, tomato, onion, and avocado over rice, with lime juice and coriander. No dairy.' },
  { name: 'Middle Eastern Falafel Plate', servingTime: 'Lunch', category: 'Middle Eastern',
    note: 'Baked (not deep-fried) chickpea falafel with a cucumber-tomato salad and a tahini drizzle, served with a small whole wheat pita. No yogurt-based sauce.' },
  { name: 'Japanese Miso Vegetable Soup with Rice', servingTime: 'Lunch', category: 'Japanese',
    note: 'Miso soup with tofu, spinach, and spring onion, served alongside a small portion of steamed rice. No dairy.' },
  { name: 'Continental Grilled Vegetable Plate', servingTime: 'Lunch', category: 'Continental',
    note: 'Grilled zucchini, bell pepper, and mushroom with olive oil, herbs, and a side of quinoa. No dairy.' },
];

function checkViruddhaPatterns(ingredients) {
  const names = (ingredients || []).map((i) => (i.name || '').toLowerCase());
  const has = (keywords) => keywords.some((k) => names.some((n) => n.includes(k)));
  const meats = ['chicken', 'fish', 'egg', 'mutton', 'prawn'];
  const curdLike = ['curd', 'yogurt'];
  const sourFruits = ['lemon', 'orange', 'pineapple', 'tamarind'];

  const warnings = [];
  if (has(meats) && has(curdLike)) warnings.push('meat/egg + curd/yogurt present together');
  if (has(['milk']) && has(sourFruits)) warnings.push('milk + sour fruit present together');
  if (has(curdLike)) warnings.push('contains curd/yogurt - verify it is not heated/cooked');
  if (has(['honey'])) warnings.push('contains honey - verify it is not heated/added to a hot liquid');
  return warnings;
}

async function main() {
  console.log(EXECUTE ? '=== EXECUTING slot-coverage import ===' : '=== DRY RUN (pass --execute to generate + create) ===');

  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected.');

  try {
    const { User, Recipe } = require('../models');
    const { syncV1FromRecipe } = require('../services/recipeVersioningService');
    const dietician = await User.findOne({ email: DIETICIAN_EMAIL, role: 'dietician' });
    if (!dietician) throw new Error(`Dietician account not found: ${DIETICIAN_EMAIL}`);
    console.log(`Target dietician: ${dietician.profile?.fullName || dietician.email} (${dietician._id})`);

    const toProcess = [];
    for (const candidate of CANDIDATES) {
      const existing = await Recipe.findOne({
        dieticianId: dietician._id,
        name: new RegExp(`^${candidate.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
      });
      if (existing) {
        console.log(`  [skip: already in DB] "${candidate.name}" (${candidate.servingTime})`);
        continue;
      }
      toProcess.push(candidate);
    }

    console.log(`\n=== PLAN: ${toProcess.length} recipe(s) ===`);
    toProcess.forEach((c, i) => console.log(`${i + 1}. "${c.name}" -> ${c.servingTime}`));

    if (!EXECUTE) {
      console.log('\nThis was a dry run - no AI generation, no DB writes. Re-run with --execute to create these.');
      return;
    }

    let created = 0;
    let failed = 0;
    for (const candidate of toProcess) {
      try {
        console.log(`\nGenerating: "${candidate.name}" (${candidate.servingTime})...`);
        const aiNote = `${candidate.note}${VIRUDDHA_NOTE_SUFFIX}`;
        const modelRecipe = await generateRecipeWithAI({
          name: candidate.name,
          servingTime: candidate.servingTime,
          servings: 1,
          dietaryHabits: { vegetarian: true },
          freeFrom: {},
          aiNote,
          languages: ['English', 'Hindi', 'Marathi'],
        });

        let ingredients = Array.isArray(modelRecipe.ingredients) ? modelRecipe.ingredients : [];
        const overrideResult = applyAiNoteQuantityOverrides({ aiNote, ingredients, servings: 1 });
        ingredients = overrideResult.ingredients;
        const { ingredients: finiteIngredients, corrections } = enforceFiniteIngredientQuantities(ingredients);
        if (corrections.length > 0) {
          console.log(`  Quantity corrections: ${corrections.map((c) => `${c.ingredient} -> ${c.to.quantity}${c.to.unit}`).join(', ')}`);
        }

        const dietWarnings = validateGeneratedIngredients({
          dietaryHabits: { vegetarian: true },
          freeFrom: {},
          ingredients: finiteIngredients,
        });
        if (dietWarnings.length > 0) console.log(`  Dietary warnings: ${dietWarnings.join(' | ')}`);

        const viruddhaWarnings = checkViruddhaPatterns(finiteIngredients);
        if (viruddhaWarnings.length > 0) {
          console.warn(`  VIRUDDHA WARNING for "${candidate.name}": ${viruddhaWarnings.join(' | ')} - review before prescribing.`);
        }

        const safeIngredients = finiteIngredients.map((ing) => ({
          ...ing,
          unit: VALID_UNITS.includes(ing.unit) ? ing.unit : 'g',
          category: VALID_INGREDIENT_CATEGORIES.includes(ing.category) ? ing.category : 'Other',
        }));

        const created_ = await Recipe.create({
          dieticianId: dietician._id,
          name: modelRecipe.name || candidate.name,
          category: modelRecipe.category || candidate.category,
          cuisine: modelRecipe.cuisine || candidate.category,
          servingTime: candidate.servingTime,
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
        // Post-save hook fires this fire-and-forget; await it explicitly too
        // (safe/idempotent, see recipeVersioningService.js) so we never
        // disconnect before RecipeVersion sync actually completes.
        await syncV1FromRecipe(created_);

        created++;
        console.log(`  ✓ Created "${modelRecipe.name || candidate.name}" [${candidate.servingTime}, ${modelRecipe.category || candidate.category}]`);
      } catch (err) {
        failed++;
        console.error(`  ✗ FAILED "${candidate.name}": ${err.message}`);
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
