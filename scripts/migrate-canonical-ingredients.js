/**
 * Rewrites every recipe's ingredient names/categories to a single canonical
 * spelling (see canonical-ingredients-data.js), fixing the grocery-list
 * duplication bug at its source: recipes today store the same real
 * ingredient under multiple spellings/casings/categories (e.g. "Coriander
 * Leaves" vs "Coriander leaves", "Green Chilli" tagged Vegetable in some
 * recipes and Spice in others), so a grocery list built by grouping on raw
 * name+category can never merge them correctly no matter how it's written.
 *
 * Only mutates `ingredients[i].name` / `ingredients[i].category` IN PLACE
 * at each existing array index - never reorders/inserts/removes entries.
 * This is a hard constraint: RecipeDetailsScreen in both Flutter apps
 * matches `Recipe.translations[lang].ingredients[]` to `Recipe.ingredients[]`
 * by array index, not by name (see models/Ingredient.js's own doc comment).
 *
 * Supplements (category:'Supplements') are excluded - their ingredients are
 * self-referential single-entry items (e.g. "Multivitamin Tablet") that
 * aren't part of the naming-collision problem; see translate-supplement-
 * facts.js for the separate, unrelated fix to their supplementFacts.
 *
 * After rewriting recipes, upserts one per-dietician Ingredient registry
 * document per canonical ingredient actually used, carrying forward any
 * previously-cached image found under an old alias spelling.
 *
 * Usage:
 *   node scripts/migrate-canonical-ingredients.js                                        # dry run, default dietician
 *   node scripts/migrate-canonical-ingredients.js --dietician-email=someone@example.com   # dry run, specific dietician
 *   node scripts/migrate-canonical-ingredients.js --execute                               # actually write
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { CANONICAL_INGREDIENTS, resolveCanonical } = require('./canonical-ingredients-data');
const { normalize } = require('../utils/ingredientLibrary');

const EXECUTE = process.argv.includes('--execute');
const dieticianEmailArg = process.argv.find((a) => a.startsWith('--dietician-email='));
const DIETICIAN_EMAIL = dieticianEmailArg ? dieticianEmailArg.split('=')[1] : 'localdietician@dev.local';

async function main() {
  console.log(EXECUTE ? '=== EXECUTING canonical ingredient migration ===' : '=== DRY RUN (pass --execute to write) ===');

  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected.');

  try {
    const { User, Recipe, Ingredient } = require('../models');
    const dietician = await User.findOne({ email: DIETICIAN_EMAIL, role: 'dietician' });
    if (!dietician) throw new Error(`Dietician account not found: ${DIETICIAN_EMAIL}`);
    console.log(`Target dietician: ${dietician.profile?.fullName || dietician.email} (${dietician._id})`);

    const recipes = await Recipe.find({
      dieticianId: dietician._id,
      category: { $ne: 'Supplements' },
    });
    console.log(`Found ${recipes.length} non-Supplement recipe(s).`);

    const unresolved = [];
    const rawNamesBefore = new Set();
    const canonicalNamesAfter = new Set();
    const plannedRecipeChanges = []; // { recipe, changes: [{index, oldName, newName, oldCategory, newCategory}] }
    const canonicalUsedInThisWeek = new Map(); // canonicalName -> CANONICAL_INGREDIENTS entry

    for (const recipe of recipes) {
      const changes = [];
      recipe.ingredients.forEach((ingredient, index) => {
        rawNamesBefore.add(ingredient.name);
        const canonical = resolveCanonical(ingredient.name);
        if (!canonical) {
          unresolved.push(`"${ingredient.name}" in recipe "${recipe.name}" (${recipe._id})`);
          return;
        }
        canonicalNamesAfter.add(canonical.canonicalName);
        canonicalUsedInThisWeek.set(canonical.canonicalName, canonical);

        const nameChanged = ingredient.name !== canonical.canonicalName;
        const categoryChanged = ingredient.category !== canonical.category;
        if (nameChanged || categoryChanged) {
          changes.push({
            index,
            oldName: ingredient.name,
            newName: canonical.canonicalName,
            oldCategory: ingredient.category,
            newCategory: canonical.category,
          });
        }
      });
      if (changes.length > 0) {
        plannedRecipeChanges.push({ recipe, changes });
      }
    }

    console.log(`\n=== PLAN ===`);
    console.log(`Distinct raw ingredient names before: ${rawNamesBefore.size}`);
    console.log(`Distinct canonical ingredient names after: ${canonicalNamesAfter.size}`);
    console.log(`Recipes needing changes: ${plannedRecipeChanges.length} / ${recipes.length}`);
    console.log(`UNRESOLVED: ${unresolved.length}`);
    if (unresolved.length > 0) {
      console.log('\nThe following ingredient names have no entry in CANONICAL_INGREDIENTS - add one before proceeding:');
      unresolved.forEach((u) => console.log(`  - ${u}`));
    }

    console.log('\n--- Per-recipe changes ---');
    plannedRecipeChanges.forEach(({ recipe, changes }) => {
      console.log(`\n"${recipe.name}" (${recipe._id}):`);
      changes.forEach((c) => {
        const nameNote = c.oldName !== c.newName ? `name "${c.oldName}" -> "${c.newName}"` : `name unchanged ("${c.oldName}")`;
        const catNote = c.oldCategory !== c.newCategory ? `category "${c.oldCategory}" -> "${c.newCategory}"` : `category unchanged`;
        console.log(`  [${c.index}] ${nameNote}, ${catNote}`);
      });
    });

    if (unresolved.length > 0) {
      console.log('\n=== STOPPING: resolve all UNRESOLVED entries before running --execute ===');
      process.exitCode = 1;
      return;
    }

    if (!EXECUTE) {
      console.log('\nThis was a dry run - no DB writes. Re-run with --execute to apply.');
      return;
    }

    // ── Apply recipe changes ──
    let recipesUpdated = 0;
    let ingredientNamesChanged = 0;
    let ingredientCategoriesChanged = 0;
    for (const { recipe, changes } of plannedRecipeChanges) {
      changes.forEach((c) => {
        if (c.oldName !== c.newName) {
          recipe.ingredients[c.index].name = c.newName;
          ingredientNamesChanged++;
        }
        if (c.oldCategory !== c.newCategory) {
          recipe.ingredients[c.index].category = c.newCategory;
          ingredientCategoriesChanged++;
        }
      });
      recipe.markModified('ingredients');
      await recipe.save();
      recipesUpdated++;
    }
    console.log(`\nRecipes updated: ${recipesUpdated}`);
    console.log(`Ingredient names changed: ${ingredientNamesChanged}`);
    console.log(`Ingredient categories changed: ${ingredientCategoriesChanged}`);

    // ── Upsert the canonical Ingredient registry ──
    let ingredientDocsUpserted = 0;
    for (const canonical of canonicalUsedInThisWeek.values()) {
      const normalizedName = normalize(canonical.canonicalName);

      // Carry forward any image already cached under one of this
      // ingredient's old alias spellings, so a photo fetched once isn't
      // lost just because the recipe now spells the name differently.
      let carriedImage = null;
      for (const alias of [canonical.canonicalName, ...canonical.aliases]) {
        const existing = await Ingredient.findOne({
          dieticianId: dietician._id,
          normalizedName: normalize(alias),
        }).lean();
        if (existing?.image) {
          carriedImage = existing.image;
          break;
        }
      }

      const setFields = {
        name: canonical.canonicalName,
        category: canonical.category,
        aliases: canonical.aliases,
        unitConversions: canonical.unitConversions,
      };
      if (canonical.friendlyUnitLabel) setFields.friendlyUnitLabel = canonical.friendlyUnitLabel;
      if (carriedImage) setFields.image = carriedImage;

      await Ingredient.findOneAndUpdate(
        { dieticianId: dietician._id, normalizedName },
        { $set: setFields },
        { upsert: true }
      );
      ingredientDocsUpserted++;
    }
    console.log(`Ingredient registry documents upserted: ${ingredientDocsUpserted}`);

    console.log('\n=== DONE ===');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB.');
  }
}

main();
