## 1. Schema

- [ ] 1.1 Add `role: { type: String, enum: ['core', 'sub'], default: 'sub' }` to `Recipe.ingredients[]` in `models/Recipe.js` and verify existing recipes still save/load without a migration (defaulted field, no required-ness added)
- [ ] 1.2 Add the same `role` field to `RecipeVersion.ingredients[]` in `models/RecipeVersion.js` and verify existing `RecipeVersion` documents still load correctly (defaulted field)

## 2. AI generation path

- [ ] 2.1 Add `role` to `utils/recipeJsonSchema.js`'s `ingredientSchema` (`required` list included, per `strict: true`) and verify `utils/openaiClient.js`'s existing Structured Outputs calls still parse successfully against the updated schema
- [ ] 2.2 Add the category-priority core-selection instruction to `generateRecipeWithAI`'s system prompt in `utils/openaiClient.js` (design.md's priority order, "whole category" not "single ingredient") and verify via manual generation calls that: a single-grain dish (e.g. Chapati) returns exactly one `role: core` ingredient, and a combo dish (e.g. Mixed Vegetable) returns every same-top-category ingredient marked `role: core`
- [ ] 2.3 Add a deterministic post-generation validator (mirroring `enforceFiniteIngredientQuantities`'s existing "backstop" pattern) that corrects a generated response with zero `core` ingredients by re-applying the category-priority heuristic (a response with one-or-more core ingredients marked needs no correction - any number is valid), and verify it with a unit test feeding a malformed 0-core response

## 3. Manual authoring path

- [ ] 3.1 In `controllers/dietician/uploadRecipieController.js`'s `createRecipe`, apply the category-priority default (marking every ingredient in the highest-priority present category) when zero ingredients are marked `role: core` in the submitted list, and otherwise honor the submitted `role` values as-is (any number of core ingredients is valid, no upper-bound rejection); verify with request tests covering zero-core, single-core, and multi-core payloads
- [ ] 3.2 Apply the same validation/defaulting to `updateRecipe` and verify with the equivalent request tests
- [ ] 3.3 Confirm `sanitizeRecipeComponents`/ingredient-sanitization helpers pass `role` through unchanged (no accidental stripping) and add a regression test if none currently covers full ingredient round-tripping

## 4. Recipe versioning service

- [ ] 4.1 Update `syncV1FromRecipe` (`services/recipeVersioningService.js`) to copy each ingredient's `role` from the parent `Recipe` onto the V1 `RecipeVersion`, matched by `foodItemId`; verify with a test asserting V1's `role` values match the source `Recipe`
- [ ] 4.2 Implement the core-group aggregate-weight detection and sub-ingredient recompute in `createCustomVersion` per design.md's Decisions: sum `resolveGramsForIngredient` across `original`'s `role: core` entries and across the submitted entries with matching `foodItemId`s, and when the two totals differ (beyond floating-point noise), overwrite every `role: sub` entry in `updatedIngredients` with `Math.round(previousSubQuantity * ratio * 100) / 100` in its existing unit; when either total can't be resolved to grams, fall through to pass-through (no recompute)
- [ ] 4.3 Verify the "no core designated" and "core group total unchanged" branches both pass `updatedIngredients` through byte-for-byte unchanged (regression tests against `tests/recipeVersioningService.test.js`'s existing pass-through cases)
- [ ] 4.4 Add tests for the new behavior: doubling a single core ingredient doubles every sub ingredient (Chapati-style, one core ingredient); growing a multi-core group's total weight scales every sub ingredient by that total's ratio regardless of how the increase is distributed among the core ingredients (Mixed Vegetable-style, several core ingredients); rebalancing within a multi-core group without changing its total leaves sub ingredients exactly as submitted; a sub-ingredient value submitted alongside an unchanged core-group total is honored verbatim; a sub-ingredient value submitted alongside a *changed* core-group total is silently overridden by the recomputed value; a core ingredient whose unit can't be resolved to grams falls back to full pass-through rather than a partial/wrong total
- [ ] 4.5 Verify `components` ("Makes (on the plate)") still rescales correctly by calorie ratio after a core-triggered sub-ingredient recompute (existing mechanism, confirm it isn't affected by the new code path)
- [ ] 4.6 Verify `createVersionFromSnapshot` (the AI-regenerated-snapshot path, `controllers/dietician/planItemController.js`'s `updateItemRecipeVersion`) either also gets `role`-aware recompute or is explicitly left out with a code comment explaining why (its snapshot already comes from a full AI regeneration, not an incremental single-ingredient edit) - resolve which, per design.md's scope, and implement accordingly

## 5. End-to-end verification

- [ ] 5.1 Run the full `tests/recipeVersioningService.test.js` and `tests/planItemCleverEndpoints.test.js` suites and confirm no regressions
- [ ] 5.2 Manually exercise `POST .../create-custom-version` against both a single-core recipe (e.g. re-saved Chapati) and a multi-core recipe (e.g. re-saved Mixed Vegetable) and confirm the response's sub-ingredient quantities match the expected proportional values for a sample core-group weight change

## 6. Optional follow-up (not required for this change to ship)

- [ ] 6.1 Note in the change's follow-up backlog (not implemented here, per design.md's Non-Goals): a separate dry-run/`--execute` backfill script applying the category-priority group heuristic to existing recipes' `Recipe.ingredients[]`, to accelerate feature coverage beyond "recipes re-saved after this ships"
