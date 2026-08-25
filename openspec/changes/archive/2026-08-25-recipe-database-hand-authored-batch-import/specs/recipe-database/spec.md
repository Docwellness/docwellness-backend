## ADDED Requirements

### Requirement: New recipes can be bulk-imported from a hand-authored dataset
The system SHALL support creating recipes directly from a complete, hand-authored JSON dataset (name, category, servingTime, ingredients with quantity/unit already specified) via `Recipe.create()`, without going through the AI-generation pipeline. Import SHALL be dry-run by default and SHALL dedup by exact recipe name per dietician, matching the existing skip-if-name-exists convention.

#### Scenario: Dry run before import
- **WHEN** the bulk-import script is run with no flags
- **THEN** it prints the planned recipe names and target slots, and how many already exist and will be skipped, without writing to the database

#### Scenario: Execute imports the dataset
- **WHEN** the bulk-import script is run with `--execute`
- **THEN** each net-new recipe in the dataset is created as a `Recipe` document owned by the target dietician, triggering the existing `RecipeVersion` auto-sync

#### Scenario: Skip already-present recipes
- **WHEN** a recipe name in the dataset already exists for that dietician
- **THEN** the script skips creating it and reports it as skipped, rather than creating a duplicate

## MODIFIED Requirements

### Requirement: Viruddha Aahara audit fixes go through the master Recipe document
Any fix for a flagged incompatible-combination or unsafe-preparation recipe SHALL be applied by editing and saving the master `Recipe` document. The system SHALL NOT insert or mutate a `RecipeVersion` document directly to apply a fix. This applies equally to recipes flagged after a hand-authored bulk import, not only to the original AI-generated or pre-existing catalog.

#### Scenario: Ingredient-swap fix
- **WHEN** a recipe is flagged for a structural incompatibility (an incompatible ingredient present in the dish)
- **THEN** the offending ingredient is removed from `Recipe.ingredients` and, where needed for the dish to still work, replaced with a compatible substitute, and the document is saved via the normal `Recipe` save path

#### Scenario: Preparation-only fix
- **WHEN** a recipe is flagged only because of how an ingredient is prepared (e.g. heated rather than added cold/after cooling)
- **THEN** `Recipe.ingredients` is left unchanged and `Recipe.instructions` is updated to state the correct preparation order, and the document is saved via the normal `Recipe` save path

#### Scenario: Fix does not affect already-published plans
- **WHEN** a `PlanItem` already references a specific `RecipeVersion._id` created before a fix
- **THEN** that `PlanItem` continues to resolve to the same `RecipeVersion` document, unchanged, after the fix is applied

#### Scenario: Re-running the fix script is a no-op
- **WHEN** the fix script is run a second time against recipes it has already fixed
- **THEN** it detects the ingredients/instructions already match the fixed state and makes no further writes

#### Scenario: Fermentation-agent curd is not treated as a heated-curd violation
- **WHEN** a recipe's curd/buttermilk is used as a fermentation or leavening agent within a batter that is subsequently steamed or baked (e.g. an idli or handvo batter), a long-established Indian culinary technique distinct from kneading fresh curd into an unfermented dough or cooking it directly into a gravy
- **THEN** the fix mechanism logs a non-blocking dietician-review note identifying the recipe, but does not alter its ingredients or instructions
