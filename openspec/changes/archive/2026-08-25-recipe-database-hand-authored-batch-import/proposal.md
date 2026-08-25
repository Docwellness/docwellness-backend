## Why

`recipe-database-ayurveda-expansion` (archived) deliberately shipped a smaller, AI-generated 18-recipe slot-coverage batch instead of the unscoped "100 recipes" the original untrusted plan floated. The dietician has now supplied the actual, fully-specified 100-recipe dataset (real ingredients/quantities/units already authored, no AI generation needed) covering all 8 serving slots. Since the data itself is complete, this is a bulk-import problem, not a generation problem, and deserves its own script and its own change rather than reopening the archived one.

## What Changes

- Add `scripts/import-hand-authored-recipes.js`: reads a hand-authored recipe dataset from `scripts/data/hand-authored-batch-1.json`, dry-run by default, `--execute` to write, dedup by exact recipe name per dietician (same convention as `add-salad-recipes.js`/`add-slot-coverage-recipes.js`), creates each via `Recipe.create()` (auto-versions via the existing post-save hook, no direct `RecipeVersion` writes).
- Import the 99 net-new recipes from the dataset (1 of the 100, `Sabudana Khichdi`, exact-name-collides with an already-present recipe and is correctly skipped, not duplicated).
- Extend the existing Viruddha-fix mechanism (`scripts/fix-viruddha-audit-recipes.js`'s `INSTRUCTION_FIXES` table) to cover **1 newly flagged recipe**: Chamomile Tea with Honey (honey added directly to hot tea, same pattern as the prior change's tea fixes).
- **No fix applied** to 3 recipes with curd baked/steamed into a fermented batter (Methi Handvo, Rava Idli with Coconut Chutney, Oats Idli) — curd/buttermilk as a fermentation agent in idli/dosa/handvo batter is a long-established Indian culinary technique, materially different from kneading fresh curd into an unfermented dough (the Palak Paratha case) or cooking it directly into a gravy (the Chicken Biryani case). Logged as a non-blocking dietician-review note, not silently ignored — see design.md's Decisions.
- **No fix needed** for 4 more recipes initially flagged by the keyword scan as ambiguous (Methi Thepla with Curd, Dahi Bhalla, Vegetable Biryani with Raita, Curd Rice — curd served cold/as a side or topping, never heated) and 2 more (Curd Poha with Pomegranate, Amla and Honey Tonic — cold-mixed, no heat source involved) — see design.md's Decisions for the reasoning on each.

## Capabilities

### Modified Capabilities
- `recipe-database`: adds a hand-authored bulk-import path alongside the existing AI-generation-pipeline path, and extends the audit-fix requirement's scope to the newly-flagged recipe from this batch.

## Impact

- `docwellness-backend/scripts/`: one new script (`import-hand-authored-recipes.js`) and one new data file (`scripts/data/hand-authored-batch-1.json`); `fix-viruddha-audit-recipes.js`'s `INSTRUCTION_FIXES` table gains one entry.
- Recipe catalog for dietician `tejasvini@docwellness.fit` grows from 109 to 208 recipes (99 net-new; `Sabudana Khichdi` duplicate correctly skipped).
- No schema changes. No `RecipeVersion` documents hand-inserted.
