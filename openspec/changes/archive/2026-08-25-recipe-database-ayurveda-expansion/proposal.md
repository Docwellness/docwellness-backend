## Why

A full Ayurvedic (Viruddha Aahara) audit of all 91 recipes in the `tejasvini@docwellness.fit` catalog found 10 recipes with real incompatible-food-combination or unsafe-preparation issues (heated curd/honey, meat+curd, cooked-together dairy) that should not be prescribed to patients as-is. Separately, several meal slots (Brunch, Night Drink, regional Lunch dishes) are thin, which forces repetition in generated 7-day plans. Both are addressed together since both touch the same recipe catalog and the same safe editing path (the `Recipe` model, whose post-save hook auto-versions `RecipeVersion` — never hand-inserted).

## What Changes

- Fix 10 audited recipes by editing the master `Recipe` document directly (auto-versions safely via the existing `syncV1FromRecipe` post-save hook — no new versioning script):
  - **Chicken Biryani**, **Palak Paratha**: ingredient swap (drop Yogurt; Biryani gets Coconut Milk for marinade moisture, Paratha gets Water for kneading).
  - **Doodhi Chilla**, **Carrot Besan Chilla**, **Moong Dal Chilla**: instructions-only fix — curd stays as an ingredient but `instructions` are updated to clarify it is served as a side/bowl, never mixed into the batter or heated.
  - **Turmeric Milk**, **Turmeric Milk with Dates**, **Tulsi Tea**, **Cinnamon Tea**, **Fennel Tea**: instructions-only fix — honey is stirred in after the liquid has cooled slightly, off heat.
  - **Oats Porridge** and **Oats Pudding** (milk+fruit) are explicitly left unchanged this round (dietician call).
- Add a `scripts/fix-viruddha-audit-recipes.js` script that applies the above 10 fixes idempotently (dry-run by default, `--execute` to write), reusing `Recipe.save()` so hooks run normally.
- Add recipe coverage for underfilled meal slots (Brunch, Night Drink, regional Lunch) via a new `scripts/add-slot-coverage-recipes.js` script, following the existing `scripts/add-salad-recipes.js` pattern exactly: `generateRecipeWithAI` + `applyAiNoteQuantityOverrides` + `validateGeneratedIngredients`, dry-run by default, targeting dietician `tejasvini@docwellness.fit` (the catalog's existing owner). Initial candidate list is ~18 named recipes (not the previously floated, unscoped "100"), split across the three thin slots — sized so each one gets real dietician review before going live.
- No `RecipeVersion` documents are ever hand-inserted or hand-mutated; both scripts only ever write to `Recipe`, relying on the existing auto-versioning hook.

## Capabilities

### New Capabilities
- `recipe-database`: requirements for auditing recipes against Viruddha Aahara rules, applying non-destructive fixes via the master `Recipe` model, and expanding meal-slot coverage through the existing AI-recipe-generation pipeline.

### Modified Capabilities
(none — no existing `openspec/specs/` capabilities predate this change)

## Impact

- `docwellness-backend/scripts/`: two new scripts (`fix-viruddha-audit-recipes.js`, `add-slot-coverage-recipes.js`).
- `Recipe` documents for the 10 named recipes (dietician `tejasvini@docwellness.fit`): ingredients and/or instructions updated; each save auto-creates a new `RecipeVersion` per existing hook behavior. Already-published `PlanItem`s keep resolving to whatever `RecipeVersion._id` they already reference, per the invariant documented on `models/RecipeVersion.js` — unaffected.
- New `Recipe` documents added for Brunch/Night Drink/regional-Lunch slots, same dietician, same AI-generation pipeline already in production use.
- No schema changes, no changes to `RecipeVersion.js`, `Recipe.js`, or `recipeVersioningService.js`.
