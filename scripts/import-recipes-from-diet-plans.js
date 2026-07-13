/**
 * Bulk-imports recipes extracted from source diet-plan documents into the
 * Recipe database, in English/Hindi/Marathi, deduped, reusing the app's
 * existing AI recipe-generation pipeline (utils/openaiClient.js's
 * generateRecipeWithAI, plus the same quantity-override and dietary-warning
 * post-processing controllers/dietician/uploadRecipieController.js applies)
 * rather than a parallel one.
 *
 * Two-stage RAG-style approach:
 *   1. "Retrieval": extractDishesFromDocument (one AI call per source file)
 *      identifies every distinct dish and pulls out exactly the source text
 *      belonging to it.
 *   2. "Generation": generateRecipeWithAI structures each dish into the
 *      app's Recipe schema, fed the real extracted text as `aiNote` so
 *      quantities are grounded in the source rather than invented, and
 *      translated into English/Hindi/Marathi.
 *
 * Requires pre-extracted plain-text versions of the source documents in
 * SOURCE_TEXT_DIR (PDFs via `pdftotext -layout`, DOCX via unzip + <w:t> tag
 * extraction - a one-time local pre-processing step, not part of this
 * script, since no PDF/DOCX-parsing library is otherwise needed in this repo).
 *
 * Usage:
 *   node scripts/import-recipes-from-diet-plans.js                     # dry run: extract + dedupe, print the plan, no AI generation/DB writes
 *   node scripts/import-recipes-from-diet-plans.js --execute           # actually generate + create recipes
 *   node scripts/import-recipes-from-diet-plans.js --execute --limit=5 # only process the first 5 deduped dishes (test run before the full batch)
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { extractDishesFromDocument, generateRecipeWithAI } = require('../utils/openaiClient');
const {
  applyAiNoteQuantityOverrides,
  enforceFiniteIngredientQuantities,
} = require('../utils/ingredientQuantityValidator');
const { validateGeneratedIngredients } = require('../utils/dietaryConstraintValidator');

const EXECUTE = process.argv.includes('--execute');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;

const SOURCE_TEXT_DIR =
  process.env.RECIPE_IMPORT_SOURCE_DIR ||
  'C:/Users/bhush/AppData/Local/Temp/claude/C--Users-bhush-docwellness-workspace/d7accd19-00f6-47fc-94f7-8686b75b15ca/scratchpad/recipe-import-source';

const DIETICIAN_EMAIL = 'localdietician@dev.local';

const VALID_UNITS = ['g', 'ml', 'cup', 'tbsp', 'tsp', 'piece'];
const VALID_INGREDIENT_CATEGORIES = [
  'Protein Rich', 'Carbohydrate', 'Vegetable', 'Dairy', 'Spice', 'Oil/Fat',
  'Sweetener', 'Grain', 'Legume', 'Nut/Seed', 'Fruit', 'Herb',
  'Sauce/Condiment', 'Other',
];

const normalizeName = (name) => (name || '').trim().toLowerCase().replace(/\s+/g, ' ');
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function dietaryHabitsForDish(dish) {
  if (dish.isNonVegetarian) return { nonVegetarian: true };
  if (dish.isEgg) return { eggitarian: true };
  if (dish.isVegetarian) return { vegetarian: true };
  return {};
}

async function main() {
  console.log(EXECUTE ? '=== EXECUTING recipe import ===' : '=== DRY RUN (pass --execute to generate + create) ===');
  if (LIMIT) console.log(`Limiting to first ${LIMIT} deduped dish(es).`);

  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected.');

  try {
    const { User, Recipe } = require('../models');

    const dietician = await User.findOne({ email: DIETICIAN_EMAIL, role: 'dietician' });
    if (!dietician) {
      throw new Error(`Dietician account not found: ${DIETICIAN_EMAIL}`);
    }
    console.log(`Target dietician: ${dietician.profile?.fullName || dietician.email} (${dietician._id})`);

    // --- Stage 1: retrieval (extraction) ---
    if (!fs.existsSync(SOURCE_TEXT_DIR)) {
      throw new Error(`Source text directory not found: ${SOURCE_TEXT_DIR}`);
    }
    const files = fs.readdirSync(SOURCE_TEXT_DIR).filter((f) => f.endsWith('.txt'));
    if (files.length === 0) {
      throw new Error(`No .txt files found in ${SOURCE_TEXT_DIR}`);
    }
    console.log(`\nFound ${files.length} staged source file(s): ${files.join(', ')}`);

    const allDishes = [];
    for (const file of files) {
      const text = fs.readFileSync(path.join(SOURCE_TEXT_DIR, file), 'utf8');
      console.log(`\nExtracting dishes from ${file}...`);
      const dishes = await extractDishesFromDocument({ documentText: text, sourceFileName: file });
      console.log(`  -> found ${dishes.length} dish(es)`);
      dishes.forEach((d) => allDishes.push({ ...d, sourceFile: file }));
    }
    console.log(`\nTotal dishes extracted across all files: ${allDishes.length}`);

    // --- Stage 2: within-batch dedup - when the same dish name appears more
    // than once, prefer a source-grounded occurrence (real ingredients) over
    // a name-only one, rather than blindly keeping whichever came first.
    const dishGroups = new Map();
    for (const dish of allDishes) {
      const key = normalizeName(dish.dishName);
      if (!dishGroups.has(key)) dishGroups.set(key, []);
      dishGroups.get(key).push(dish);
    }
    const dedupedDishes = [];
    let withinBatchSkipped = 0;
    for (const group of dishGroups.values()) {
      const chosen = group.find((d) => d.hasStructuredIngredients) || group[0];
      dedupedDishes.push(chosen);
      if (group.length > 1) {
        withinBatchSkipped += group.length - 1;
        group.forEach((d) => {
          if (d !== chosen) {
            console.log(
              `  [skip: duplicate in batch, kept ${chosen.hasStructuredIngredients ? 'grounded' : 'name-only'} version from ${chosen.sourceFile}] "${d.dishName}" (${d.sourceFile})`
            );
          }
        });
      }
    }
    console.log(
      `\nAfter within-batch dedup: ${dedupedDishes.length} unique dish(es), ${withinBatchSkipped} skipped as duplicates.`
    );

    // --- Stage 3: dedup against the database ---
    const toProcess = [];
    let dbSkipped = 0;
    for (const dish of dedupedDishes) {
      const existing = await Recipe.findOne({
        dieticianId: dietician._id,
        name: new RegExp(`^${escapeRegex(dish.dishName)}$`, 'i'),
      });
      if (existing) {
        dbSkipped++;
        console.log(`  [skip: already in DB] "${dish.dishName}"`);
        continue;
      }
      toProcess.push(dish);
    }
    console.log(
      `\nAfter DB dedup: ${toProcess.length} dish(es) to ${EXECUTE ? 'generate + create' : 'plan'}, ${dbSkipped} already existed.`
    );

    const finalList = LIMIT ? toProcess.slice(0, LIMIT) : toProcess;

    console.log(`\n=== PLAN: ${finalList.length} recipe(s) ===`);
    finalList.forEach((d, i) => {
      console.log(
        `${i + 1}. "${d.dishName}" [${d.servingTime}] veg=${d.isVegetarian} egg=${d.isEgg} nonVeg=${d.isNonVegetarian} source=${d.hasStructuredIngredients ? 'grounded' : 'AI-generated-from-name'} (${d.sourceFile})`
      );
    });

    if (!EXECUTE) {
      console.log('\nThis was a dry run - no AI generation, no DB writes. Re-run with --execute to create these recipes.');
      return;
    }

    // --- Stage 4: per-dish structuring/generation + write ---
    let created = 0;
    let failed = 0;
    const allCorrections = [];
    for (const dish of finalList) {
      try {
        console.log(`\nGenerating: "${dish.dishName}"...`);
        const aiNote = dish.hasStructuredIngredients
          ? `Ingredients (dietician-provided, authoritative quantities where given):\n${dish.rawIngredientsText}${
              dish.rawRecipeText ? `\n\nMethod:\n${dish.rawRecipeText}` : ''
            }`
          : undefined;

        const dietaryHabits = dietaryHabitsForDish(dish);

        const modelRecipe = await generateRecipeWithAI({
          name: dish.dishName,
          servingTime: dish.servingTime,
          servings: 1,
          dietaryHabits,
          freeFrom: {},
          aiNote,
          languages: ['English', 'Hindi', 'Marathi'],
        });

        let ingredients = Array.isArray(modelRecipe.ingredients) ? modelRecipe.ingredients : [];
        if (aiNote) {
          const overrideResult = applyAiNoteQuantityOverrides({ aiNote, ingredients, servings: 1 });
          ingredients = overrideResult.ingredients;
          if (overrideResult.appliedOverrides.length > 0) {
            console.log(
              `  Quantity overrides from source: ${overrideResult.appliedOverrides
                .map((o) => `${o.ingredient} -> ${o.to.quantity}${o.to.unit}`)
                .join(', ')}`
            );
          }
        }

        const { ingredients: finiteIngredients, corrections } = enforceFiniteIngredientQuantities(ingredients);
        if (corrections.length > 0) {
          console.log(
            `  Quantity corrections (no source amount given): ${corrections
              .map((c) => `${c.ingredient} -> ${c.to.quantity}${c.to.unit}`)
              .join(', ')}`
          );
          allCorrections.push({ dish: dish.dishName, corrections });
        }

        const warnings = validateGeneratedIngredients({ dietaryHabits, freeFrom: {}, ingredients: finiteIngredients });
        if (warnings.length > 0) {
          console.log(`  Warnings: ${warnings.join(' | ')}`);
        }

        const safeIngredients = finiteIngredients.map((ing) => ({
          ...ing,
          unit: VALID_UNITS.includes(ing.unit) ? ing.unit : 'g',
          category: VALID_INGREDIENT_CATEGORIES.includes(ing.category) ? ing.category : 'Other',
        }));

        await Recipe.create({
          dieticianId: dietician._id,
          name: modelRecipe.name || dish.dishName,
          category: modelRecipe.category || 'Indian',
          cuisine: modelRecipe.cuisine || 'Indian',
          description: modelRecipe.description || '',
          servingTime: dish.servingTime,
          servings: 1,
          preparationTime: modelRecipe.preparationTime,
          cookingTime: modelRecipe.cookingTime,
          dietaryHabits,
          freeFrom: {},
          servingSize: modelRecipe.servingSize,
          ingredients: safeIngredients,
          instructions: modelRecipe.cookingSteps || [],
          nutrition: modelRecipe.nutrition,
          language: ['English', 'Hindi', 'Marathi'],
          translations: modelRecipe.translations || {},
        });

        created++;
        console.log(`  ✓ Created "${modelRecipe.name || dish.dishName}" [${modelRecipe.category}]`);
      } catch (err) {
        failed++;
        console.error(`  ✗ FAILED "${dish.dishName}": ${err.message}`, err.errors ? JSON.stringify(err.errors) : '');
      }
    }

    console.log('\n=== DONE ===');
    console.log(
      `Created: ${created}, Failed: ${failed}, Skipped (batch duplicate): ${withinBatchSkipped}, Skipped (already in DB): ${dbSkipped}`
    );
    if (allCorrections.length > 0) {
      console.log('\nRecipes with quantity corrections (please spot-review):');
      allCorrections.forEach(({ dish, corrections }) => {
        console.log(`  - ${dish}: ${corrections.map((c) => c.ingredient).join(', ')}`);
      });
    }
  } catch (error) {
    console.error('Import failed:', error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB.');
  }
}

main();
