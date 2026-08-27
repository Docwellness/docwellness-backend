## Why

In the diet-plan wizard's Refine step (Ingredient Editor), a dietician edits a recipe's ingredient quantities as independent number fields — e.g. Chapati shows Whole Wheat Flour, Water, Salt, and Ghee as four separately-editable fields. Nothing links them: changing Whole Wheat Flour from 41g to 82g leaves Water/Salt/Ghee at their old values, silently breaking the recipe's real proportions (double the flour with the same water gives unusable dough, not a doubled chapati). Every recipe already has one or more ingredients whose quantities are the actually clinically/portion-meaningful ones (the grain/protein/vegetables a dietician is really adjusting — for a single-grain dish like Chapati that's just Whole Wheat Flour, but for a combo dish like Mixed Vegetable or Vegetable Korma it's every vegetable in the mix together, not any single one of them) and several whose amounts only make sense relative to that group — the system just has no way to say which ingredients are which, or to keep the rest in ratio when that group's total changes.

## What Changes

- Add a per-ingredient **role** designation — **one or more** `core` ingredients per recipe (a recipe needs at least one; there is no upper limit, so a combo dish's entire vegetable mix can all be `core` together), the rest `sub` — authored at recipe-creation time (AI generation and manual authoring) and carried through to every `RecipeVersion`.
- When a dietician edits any `core` ingredient's quantity (one or several) in the Ingredient Editor and saves, the backend compares the **total weight of the core group** (summed in grams, converting each core ingredient's unit via the existing `resolveGramsForIngredient` helper) before and after, and — if that total changed — recomputes every **sub** ingredient's quantity in that same ratio, rather than trusting whatever the client submitted for them. Each `core` ingredient's own submitted quantity is always honored verbatim (that's the whole point — the dietician can freely rebalance carrots vs. peas within the mix); only `sub` ingredients get recomputed.
- A dietician can still edit a **sub** ingredient's quantity directly (e.g. "less salt for a hypertensive patient") — as long as the core group's total weight is unchanged in that same save, the submitted sub value is trusted as an intentional override and is what the *next* edit's ratios are computed from, exactly as the core group's own history already works.
- `generateRecipeWithAI` picks sensible core ingredient(s) automatically (category-priority heuristic — every ingredient in whichever of Grain/Carbohydrate/Protein Rich/Legume is actually present becomes core, not just one — see design.md), and the manual recipe-authoring API/UI gets a way to set or move the `core` designation(s) by hand.
- **BREAKING (behavior, not request shape)**: `POST .../create-custom-version` keeps accepting the exact same `{planItemId, ingredients}` shape it does today, but no longer honors a submitted sub-ingredient quantity at face value when the core group's total weight changed in the same request — it's server-recomputed from the recipe's proportions instead. A client that relies on setting both a new core quantity and a custom sub-ingredient quantity in one Save needs two saves going forward. See design.md's Decisions for the exact contract and rationale.

## Capabilities

### New Capabilities
- `recipe-ingredient-scaling`: the runtime behavior of how ingredient quantities move together when the core group changes — aggregate core-weight ratio computation, when it fires, and how a sub-ingredient override is distinguished from a stale value.

### Modified Capabilities
- `recipe-database`: `Recipe.ingredients[]` gains a `role` field; AI generation (`generateRecipeWithAI`) and manual authoring (`createRecipe`/`updateRecipe`) must both designate at least one `core` ingredient per recipe (any number, not capped at one).

## Impact

- `models/Recipe.js`, `models/RecipeVersion.js`: schema addition (`role` enum per ingredient).
- `utils/recipeJsonSchema.js`, `utils/openaiClient.js`: Structured Outputs schema + prompt changes for core-ingredient-group selection.
- `controllers/dietician/uploadRecipieController.js` (`createRecipe`, `updateRecipe`): manual core-designation input/validation (at-least-one, not exactly-one).
- `services/recipeVersioningService.js` (`syncV1FromRecipe`, `createCustomVersion`, reusing the existing `resolveGramsForIngredient`): carry `role` onto `RecipeVersion.ingredients[]`; `createCustomVersion` gains the aggregate-ratio-recompute logic.
- `controllers/dietician/planItemController.js` (`createCustomRecipeVersion`): request/response contract change for the Ingredient Editor save flow.
- Not in this repo: the Flutter dietician app's Ingredient Editor screen (visually distinguishing every core field, live client-side preview as the dietician types, before the save round-trip that this proposal's backend contract governs).
- Out of scope, unrelated bug (tracked separately, not fixed here): 123 of the catalog's 214 recipes are also missing the `components` ("Makes (on the plate)") field entirely — a different root cause (several past import scripts never set it), not a role/proportion problem. No `role` backfill is attempted for existing recipes' ingredients in this change either — see design.md's Migration Plan for why and what happens to old recipes instead.
