/**
 * Read-only scan for cross-recipe content leakage in cooking steps - the
 * "Matki Usal's own steps mention Jowar Bhakri and koshimbir" bug, which
 * looks like the original document-import pipeline not cleanly splitting a
 * combo meal's raw text per-dish (see utils/openaiClient.js's
 * extractDishesFromDocument, whose whole job is that split).
 *
 * For every recipe R, checks whether any OTHER recipe R2's name appears as
 * a whole-word/phrase match inside R's own cooking-steps text (English
 * `instructions` plus every language's `translations[lang].cookingSteps`).
 * Purely deterministic name cross-referencing, no AI involved - cheap and
 * catches exactly this class of bug (a real, distinct dish name leaking
 * into an unrelated recipe's steps), though it can't catch contamination
 * that doesn't use another recipe's literal name. Makes no writes; this is
 * a report for manual review, not an auto-fixer - a legitimate multi-dish
 * "combo" recipe (e.g. a thali) may reference other dish names on purpose.
 *
 * Usage:
 *   node scripts/audit-cross-recipe-step-contamination.js [outFile]
 *   (defaults to recipe-step-contamination-audit.json in the repo root)
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const connectDB = require('../config/database');

const OUT_FILE = process.argv[2] || path.join(__dirname, '..', 'recipe-step-contamination-audit.json');

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stepsTextFor(recipe) {
  const chunks = [...(recipe.instructions || [])];
  const translations = recipe.translations instanceof Map ? recipe.translations : new Map(Object.entries(recipe.translations || {}));
  for (const translation of translations.values()) {
    chunks.push(...(translation?.cookingSteps || []));
  }
  return chunks.join('\n');
}

async function main() {
  await connectDB();
  try {
    const { Recipe } = require('../models');

    const recipes = await Recipe.find({}).select('name instructions translations').lean();
    // Only cross-reference against names distinctive enough to avoid noise
    // from a single common word (e.g. a hypothetical recipe just named
    // "Salad") matching everywhere - require at least 2 words.
    const candidateNames = recipes.filter((r) => (r.name || '').trim().split(/\s+/).length >= 2);

    const findings = [];
    for (const recipe of recipes) {
      const stepsText = stepsTextFor(recipe);
      if (!stepsText.trim()) continue;

      for (const other of candidateNames) {
        if (String(other._id) === String(recipe._id)) continue;
        const pattern = new RegExp(`\\b${escapeRegExp(other.name)}\\b`, 'i');
        const match = stepsText.match(pattern);
        if (!match) continue;

        const contextStart = Math.max(0, match.index - 40);
        const contextEnd = Math.min(stepsText.length, match.index + match[0].length + 40);
        findings.push({
          recipe: recipe.name,
          recipeId: String(recipe._id),
          mentionedRecipe: other.name,
          mentionedRecipeId: String(other._id),
          context: `...${stepsText.slice(contextStart, contextEnd).replace(/\n/g, ' ')}...`,
        });
      }
    }

    const output = { summary: { totalRecipes: recipes.length, findingsCount: findings.length }, findings };
    fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
    console.log(`Wrote audit to ${OUT_FILE}`);
    console.log(JSON.stringify(output.summary, null, 2));
  } finally {
    await require('mongoose').disconnect();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
