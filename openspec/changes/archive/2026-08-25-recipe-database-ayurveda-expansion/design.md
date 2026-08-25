## Context

See proposal.md - Why/What Changes for motivation and the fix list. Relevant existing machinery this design builds on:
- `models/Recipe.js`'s `post('save')` hook calls `services/recipeVersioningService.js`'s `syncV1FromRecipe`, which is the *only* sanctioned way `RecipeVersion` documents get created/updated. It never mutates a `RecipeVersion` already referenced by a `PlanItem`; it bumps a new version instead. Editing `Recipe` and calling `.save()`/`.create()` is therefore sufficient and safe — no new versioning code is needed.
- `scripts/add-salad-recipes.js` and `scripts/add-side-dish-recipes.js` are the established pattern for adding AI-generated recipes: `generateRecipeWithAI` (utils/openaiClient.js) → `applyAiNoteQuantityOverrides` + `enforceFiniteIngredientQuantities` (utils/ingredientQuantityValidator.js) → `validateGeneratedIngredients` (utils/dietaryConstraintValidator.js) → `Recipe.create(...)`. Both scripts are dry-run by default, `--execute` to write, and skip names already present for the target dietician.
- Real slot counts across the 91 recipes (from `scripts/exportRecipesForAudit.js` output): Breakfast 21, Lunch 23, Dinner 13, Morning Drink 11, Evening Snack 8, Night Drink 8, Brunch 7. Brunch and Night Drink are numerically thinnest; Lunch, while numerically fine, is 18/23 "Indian" category with almost no cuisine variety.
- All 91 existing recipes belong to a single dietician, `tejasvini@docwellness.fit`. New recipes target the same dietician so they show up in the same catalog being expanded.

## Goals / Non-Goals

**Goals:**
- Fix the 10 audited recipes without introducing any new data-mutation path outside the existing `Recipe` save flow.
- Add real slot/cuisine variety (Brunch, Night Drink, non-Indian Lunch options) using the pipeline already proven in production scripts.
- Keep both scripts safe to re-run (idempotent, dry-run-first).

**Non-Goals:**
- Building a general-purpose nutrition-calculation engine or ingredient-to-gram conversion table — `recipeVersioningService.js` already resolves ingredient nutrition via `FoodItem` when generating `RecipeVersion` V1; nothing here duplicates that.
- Building a general-purpose Viruddha Aahara rules engine that blocks recipe creation — this change only needs prompt-time guidance plus a non-blocking post-generation warning (see spec's "avoid known Viruddha combinations" requirement).
- Fixing Oats Porridge / Oats Pudding (milk+fruit) — explicitly deferred by the dietician's own call.
- Reaching "100 new recipes" — an unscoped number from an earlier, untrusted draft. This change ships ~18 named recipes; further expansion is a separate future change once these are reviewed live.

## Decisions

**Fix script edits `Recipe` in place, not a bespoke V2-creation script.**
The originally floated approach (`fix-audit-recipes.js` hand-inserting `RecipeVersion` V2 documents) bypasses `parentRecipeId`/`foodItemId` requirements and duplicates versioning logic that already exists and is better-tested. Editing `Recipe` and letting the post-save hook run is strictly simpler and reuses an invariant already covered by `tests/recipeVersioningService.test.js`.

**Chilla/tea/milk fixes are instructions-only, not ingredient removal.**
Per dietician direction: the Viruddha concern for these 8 recipes is specifically about *heating* dairy/honey, not about the ingredient's presence. Removing curd or honey would change the dish unnecessarily. `Recipe.instructions` (a plain `[String]` array) is the right place to encode "add after cooling" / "serve on the side" guidance — no schema change needed.

**Chicken Biryani / Palak Paratha get a real ingredient swap.**
These two are structural (meat+curd; curd cooked directly into a dough that then gets heated) — an instructions note can't resolve them without changing the dish. Coconut Milk (Biryani) and Water (Paratha) are the minimal substitutes that preserve the original ingredient's culinary role (moisture) without reintroducing dairy-heating.

**Candidate recipe list is explicit and small (~18), not AI-improvised at scale.**
Matches the existing scripts' convention (a hardcoded array of `{name, note}` the AI fleshes out) and keeps AI-generation cost and dietician review load bounded. Initial candidates:
- Brunch (+6): Sabudana Khichdi, Vegetable Sandwich, Ragi Idli with Coconut Chutney, Corn Chaat, Baked Sweet Potato Chaat, Roasted Foxnut Trail Mix (renamed from an earlier draft to avoid overlapping the existing "Roasted Makhana and Chana"/"Roasted Chana with Makhana and Seeds" Evening Snack recipes)
- Night Drink (+6): Chamomile Tea, Ashwagandha Milk, Saffron Milk, Warm Amla Water, Licorice Tea, Nutmeg Milk
- Lunch, non-Indian variety (+6): Mediterranean Chickpea Bowl, Thai Vegetable Curry with Rice, Mexican Black Bean Bowl, Middle Eastern Falafel Plate, Japanese Miso Vegetable Soup with Rice, Continental Grilled Vegetable Plate

Each entry follows the `{name, note}` shape from `add-salad-recipes.js`'s `SALADS` array, with the note explicitly telling the AI to avoid meat+dairy, heated curd/honey, and milk+sour-fruit combinations.

## Risks / Trade-offs

- [Ambiguous chilla fix may not fully satisfy strict Viruddha interpretation if a dietician actually does mix curd into the batter in practice] → Mitigation: instructions are explicit and dietician-reviewable; if wrong, it's a one-line instructions edit, not a data-model change.
- [AI-generated new recipes could still produce a flagged combination despite prompt guidance] → Mitigation: post-generation keyword check logs a warning for manual review (per spec); nothing is silently trusted.
- [Coconut Milk / Water substitutions change taste/texture of two long-standing recipes] → Mitigation: dietician (catalog owner) reviews the diff before/after `--execute` dry run output; easy to hand-tune further in the UI afterward since it's a normal `Recipe` edit.

## Migration Plan

1. Run `node scripts/fix-viruddha-audit-recipes.js` (dry run) — review output.
2. Run `node scripts/fix-viruddha-audit-recipes.js --execute` — writes to the 8 in-scope recipes (Chicken Biryani, Palak Paratha, 3 chillas, 3 of the honey drinks... see tasks.md for the full 10-minus-2 list).
3. Run `node scripts/add-slot-coverage-recipes.js` (dry run) — review the candidate list.
4. Run `node scripts/add-slot-coverage-recipes.js --execute` — creates new `Recipe` docs.
5. No rollback machinery needed beyond normal `Recipe` edits/deletes — nothing here is destructive or irreversible; a fixed recipe can be hand-edited back via the dietician UI if a review disagrees with a substitution.
