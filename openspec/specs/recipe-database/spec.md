# recipe-database Specification

## Purpose

Governs how the dietician-authored recipe catalog is audited for Ayurvedic (Viruddha Aahara) incompatibilities and fixed, and how new recipes are added to fill out thin meal-slot coverage, both without ever bypassing the existing `Recipe` → `RecipeVersion` auto-versioning safety mechanism.

## Requirements

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

### Requirement: Audit-fix script is dry-run by default
The system SHALL provide a script that lists which of the 10 audited recipes would be changed and how, without writing to the database, unless explicitly told to execute.

#### Scenario: Default invocation
- **WHEN** the fix script is run with no flags
- **THEN** it prints the planned ingredient/instruction changes per recipe and makes no database writes

#### Scenario: Explicit execute
- **WHEN** the fix script is run with `--execute`
- **THEN** it applies the planned changes to the named `Recipe` documents

### Requirement: New recipes are added through the existing AI-generation pipeline
New recipes added to fill meal-slot coverage gaps SHALL be created using the same `generateRecipeWithAI` + ingredient-validation pipeline already used by `scripts/add-salad-recipes.js`, targeting the existing catalog's owning dietician. The system SHALL NOT introduce a separate hand-authored nutrition-calculation table or a parallel recipe-creation path.

#### Scenario: Dry run before generation
- **WHEN** the slot-coverage script is run with no flags
- **THEN** it prints the planned recipe names and target slots without calling the AI generator or writing to the database

#### Scenario: Execute generates and validates
- **WHEN** the slot-coverage script is run with `--execute`
- **THEN** each planned recipe is generated via `generateRecipeWithAI`, its ingredients pass through `validateGeneratedIngredients`, and it is created as a `Recipe` document owned by the catalog's existing dietician

#### Scenario: Skip already-present recipes
- **WHEN** a planned recipe name already exists for that dietician
- **THEN** the script skips generating it and reports it as skipped

### Requirement: New recipes avoid known Viruddha combinations by construction
Each new recipe's generation prompt SHALL explicitly instruct the AI to avoid the incompatible-combination patterns found in the audit (meat with curd/yogurt, heated curd or honey, milk with sour fruit). Generated ingredients SHALL be checked against these patterns after generation and any match SHALL be logged as a warning for dietician review, without blocking creation.

#### Scenario: Generation-time guidance
- **WHEN** a new recipe is generated
- **THEN** the AI prompt's note includes an instruction not to combine meat with dairy, not to cook/heat curd or honey, and not to combine milk with sour fruit

#### Scenario: Post-generation warning
- **WHEN** a generated recipe's ingredients nonetheless match one of the known incompatible patterns
- **THEN** the script logs a warning identifying the recipe and the pattern, and still creates the recipe for manual dietician review

### Requirement: Every recipe designates at least one core ingredient
Each `Recipe` document's `ingredients[]` SHALL carry a `role` of either `core` or `sub`. A recipe with at least one ingredient SHALL have at least one ingredient marked `core` — there is no upper limit on how many ingredients may be `core` (a combo/mixed dish, e.g. Mixed Vegetable or Vegetable Korma, MAY have several ingredients marked `core` together, with only seasoning/oil/liquid as `sub`). A recipe with zero ingredients marked `core` (e.g. one authored before this requirement existed) is treated as not-yet-migrated rather than invalid — see the `recipe-ingredient-scaling` capability for the resulting fallback behavior.

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
