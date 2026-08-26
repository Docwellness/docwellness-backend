## ADDED Requirements

### Requirement: Every recipe designates at least one core ingredient
Each `Recipe` document's `ingredients[]` SHALL carry a `role` of either `core` or `sub`. A recipe with at least one ingredient SHALL have at least one ingredient marked `core` — there is no upper limit on how many ingredients may be `core` (a combo/mixed dish, e.g. Mixed Vegetable or Vegetable Korma, MAY have every vegetable in the mix marked `core` together, with only seasoning/oil/liquid as `sub`). A recipe with zero ingredients marked `core` (e.g. one authored before this requirement existed) is treated as not-yet-migrated rather than invalid — see the `recipe-ingredient-scaling` capability for the resulting fallback behavior, and this change's design.md for why no bulk backfill is performed.

#### Scenario: AI-generated recipe designates its core ingredient group
- **WHEN** a new recipe is generated via `generateRecipeWithAI`
- **THEN** every ingredient in the highest-priority category actually present in the recipe (category priority: Grain, Carbohydrate, Protein Rich, and Legume ranked above Dairy, Vegetable, Fruit, and Nut/Seed, ranked above Spice, Oil/Fat, Sweetener, Herb, Sauce/Condiment, and Other) is marked `role: core`, and every other ingredient is marked `role: sub`

#### Scenario: A combo dish's entire core-category group is marked core
- **WHEN** a generated or manually authored recipe contains multiple ingredients in the same highest-priority category (e.g. Carrot, Beans, Peas, and Cauliflower, all `Vegetable`, in a Mixed Vegetable dish with no higher-priority category present)
- **THEN** all of those ingredients are marked `role: core` together, not just one of them

#### Scenario: Manually authored recipe defaults its core ingredient(s) when none is specified
- **WHEN** a dietician creates or updates a recipe via `createRecipe`/`updateRecipe` without marking any ingredient's `role`
- **THEN** the system applies the same category-priority heuristic to select the core ingredient group, rather than rejecting the save

#### Scenario: Manually authored recipe honors an explicit core designation
- **WHEN** a dietician's request marks one or more ingredients as `role: core`
- **THEN** exactly those ingredients are saved as core and every other ingredient as `sub`, regardless of what the heuristic would have picked

### Requirement: Recipe versioning carries the core/sub designation forward
`RecipeVersion.ingredients[]` SHALL include each ingredient's `role`, copied from the parent `Recipe` at V1 creation and preserved by every subsequent version derived from it.

#### Scenario: V1 sync copies role
- **WHEN** a `Recipe` is saved and its V1 `RecipeVersion` is synced
- **THEN** each `RecipeVersion.ingredients[]` entry's `role` matches its corresponding `Recipe.ingredients[]` entry (matched by `foodItemId`)
