// Atlas mongosh version of migrate-recipe-components.js - for pasting into
// Atlas's browser-based shell (Cluster -> Connect -> "Open MongoDB Shell",
// or the shell icon in the Data Explorer) when the machine running Claude
// Code can't reach the cluster's network directly. Same logic as the Node
// script, translated to plain mongosh (no Mongoose, no external modules).
//
// Usage (paste into the shell, one block at a time):
//   1. Run STEP 1 below - it's read-only, just builds a plan in the `ops`
//      variable and prints a summary. Review the printed skip list.
//   2. Run STEP 2 (bulkWrite) once you're satisfied with the plan - this is
//      the only step that writes anything.
//
// Idempotent - only touches recipes with no `components` yet, so it's safe
// to re-run.

// ---- STEP 1: build the plan (read-only) ----
use('docwellness');

var ops = [];
var planned = 0;
var skipped = 0;

db.recipes
  .find({ $or: [{ components: { $exists: false } }, { components: { $size: 0 } }] })
  .forEach(function (recipe) {
    var quantity = recipe.servingSize && recipe.servingSize.quantity;
    var unit = recipe.servingSize && recipe.servingSize.unit;

    if (!(quantity > 0) || !unit) {
      skipped++;
      print('[skip: no usable servingSize] "' + recipe.name + '" (' + recipe._id + ')');
      return;
    }

    var components = [{ label: recipe.name || 'Serving', quantity: quantity, unit: unit }];
    if (
      recipe.secondaryComponent &&
      recipe.secondaryComponent.quantity > 0 &&
      recipe.secondaryComponent.unit
    ) {
      components.push({
        label: recipe.secondaryComponent.label || 'Add-on',
        quantity: recipe.secondaryComponent.quantity,
        unit: recipe.secondaryComponent.unit,
      });
    }

    planned++;
    ops.push({
      updateOne: {
        filter: { _id: recipe._id },
        update: { $set: { components: components } },
      },
    });
  });

print('');
print('=== PLAN: ' + planned + ' recipe(s) to backfill, ' + skipped + ' skipped (needs manual review) ===');
print('Run STEP 2 (db.recipes.bulkWrite(ops)) to actually write these.');

// ---- STEP 2: execute (only run after reviewing STEP 1's output) ----
// var result = db.recipes.bulkWrite(ops);
// print('Modified: ' + result.modifiedCount);
