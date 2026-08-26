/**
 * Read-only audit for recipes whose NAME bundles a main dish with a side
 * (e.g. "Bharli Vangi with Bhakri") - per the standing decision that a side
 * (Bhakri, Roti, Rice, etc.) must be its own separate Recipe document, not
 * folded into a single recipe's identity. This is exactly the accompaniment
 * pattern services/menuGenerationService.js already models via a PlanItem's
 * own isLinkedComponent/parentRecipeId (see models/PlanItem.js) - a bundled
 * name like this bypasses that pairing and instead hard-codes one specific
 * side into the main dish's name/ingredient list, which then can't be
 * swapped or reused independently.
 *
 * Flags a recipe when its name contains the whole word "with" (the pattern
 * the reported example used) - reports name/id/category/cuisine plus
 * whether its own ingredients list actually contains an item matching the
 * apparent side name (helps tell "truly missing, side is baked into the
 * name only" apart from "side is already a listed ingredient, just also
 * named in the title").
 *
 * Makes no writes; this is a report for manual review/cleanup.
 *
 * Usage:
 *   node scripts/audit-side-bundled-recipe-names.js [outFile]
 *   (defaults to side-bundled-recipe-audit.json in the repo root)
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const connectDB = require('../config/database');

const OUT_FILE = process.argv[2] || path.join(__dirname, '..', 'side-bundled-recipe-audit.json');

async function main() {
  await connectDB();
  try {
    const { Recipe } = require('../models');

    const recipes = await Recipe.find({ name: /\bwith\b/i })
      .select('name category cuisine dieticianId ingredients components status')
      .lean();

    const findings = recipes.map((r) => {
      const match = r.name.match(/^(.*)\bwith\b(.*)$/i);
      const mainPart = match ? match[1].trim() : r.name;
      const sidePart = match ? match[2].trim() : '';
      const sideNameLower = sidePart.toLowerCase();
      const ingredientNames = (r.ingredients || []).map((i) => i.name);
      const sideAlreadyAnIngredient = sideNameLower
        ? ingredientNames.some((n) => n.toLowerCase().includes(sideNameLower) || sideNameLower.includes(n.toLowerCase()))
        : false;

      return {
        id: String(r._id),
        name: r.name,
        mainPart,
        sidePart,
        category: r.category,
        cuisine: r.cuisine,
        status: r.status,
        dieticianId: r.dieticianId ? String(r.dieticianId) : null,
        ingredientCount: ingredientNames.length,
        ingredientNames,
        componentCount: (r.components || []).length,
        sideAlreadyAnIngredient,
      };
    });

    fs.writeFileSync(OUT_FILE, JSON.stringify(findings, null, 2));
    console.log(`Scanned ${recipes.length} recipe(s) with "with" in the name. Wrote ${findings.length} finding(s) to ${OUT_FILE}`);
    for (const f of findings) {
      console.log(`- [${f.id}] "${f.name}" (${f.category}/${f.cuisine}) - ingredients: ${f.ingredientNames.join(', ') || '(none)'}`);
    }
  } finally {
    await require('mongoose').disconnect();
  }
}

main().catch((err) => {
  console.error('audit-side-bundled-recipe-names failed:', err);
  process.exit(1);
});
