## ADDED Requirements

### Requirement: Every recipe designates at least one core ingredient
Each `Recipe` document's `ingredients[]` SHALL carry a `role` of either `core` or `sub`. A recipe with at least one ingredient SHALL have at least one ingredient marked `core` — there is no upper limit on how many ingredients may be `core` (a combo/mixed dish, e.g. Mixed Vegetable or Vegetable Korma, MAY have several ingredients marked `core` together, with only seasoning/oil/liquid as `sub`). A recipe with zero ingredients marked `core` (e.g. one authored before this requirement existed) is treated as not-yet-migrated rather than invalid — see the `recipe-ingredient-scaling` capability for the resulting fallback behavior, and this change's design.md for why no bulk backfill is performed.

The category-priority heuristic (category priority: Grain, Carbohydrate, Protein Rich, and Legume ranked above Dairy, Vegetable, Fruit, and Nut/Seed, ranked above Spice, Oil/Fat, Sweetener, Herb, Sauce/Condiment, and Other) is prompt guidance for AI generation, not a mechanically-enforced guarantee of exactly which ingredients end up `core` — the model's judgment about a dish's real bulk-vs-flavor-base split (e.g. treating an onion/tomato base as `sub` even within an otherwise-`core` Vegetable category) MAY reasonably diverge from a strict same-category grouping. The only hard guarantee for AI-generated recipes is at-least-one-`core` (see the zero-core correction scenario below); the deterministic, code-computed version of the heuristic — applied exactly, with no judgment call — is reserved for the manual-authoring default and the zero-core correction, where there's no model output to defer to.

#### Scenario: AI-generated recipe is prompted to designate a sensible core ingredient group
- **WHEN** a new recipe is generated via `generateRecipeWithAI`
- **THEN** the generation prompt instructs the model to mark the dish's portion-meaningful ingredient(s) `role: core` (using the category-priority order as guidance) and everything else `role: sub`, and the resulting recipe has at least one `core` ingredient

#### Scenario: A zero-core AI response is corrected deterministically
- **WHEN** a generated recipe's ingredients come back with no ingredient marked `role: core`
- **THEN** the system deterministically applies the category-priority heuristic (every ingredient in the single highest-priority category present becomes `core`) to correct the response before it's used, rather than allowing a recipe with zero core ingredients

#### Scenario: Manually authored recipe defaults its core ingredient(s) when none is specified
- **WHEN** a dietician creates or updates a recipe via `createRecipe`/`updateRecipe` without marking any ingredient's `role`
- **THEN** the system deterministically applies the category-priority heuristic (every ingredient in the single highest-priority category present becomes `core`, together) to select the core ingredient group, rather than rejecting the save

#### Scenario: Manually authored recipe honors an explicit core designation
- **WHEN** a dietician's request marks one or more ingredients as `role: core`
- **THEN** exactly those ingredients are saved as core and every other ingredient as `sub`, regardless of what the heuristic would have picked

### Requirement: Recipe versioning carries the core/sub designation forward
`RecipeVersion.ingredients[]` SHALL include each ingredient's `role`, copied from the parent `Recipe` at V1 creation and preserved by every subsequent version derived from it.

#### Scenario: V1 sync copies role
- **WHEN** a `Recipe` is saved and its V1 `RecipeVersion` is synced
- **THEN** each `RecipeVersion.ingredients[]` entry's `role` matches its corresponding `Recipe.ingredients[]` entry (matched by `foodItemId`)
