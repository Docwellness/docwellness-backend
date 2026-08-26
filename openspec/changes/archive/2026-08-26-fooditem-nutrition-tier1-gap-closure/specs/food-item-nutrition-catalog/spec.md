## Purpose

Governs the global, dietician-independent `FoodItem` nutrition data layer that `RecipeVersion` resolution depends on — how ingredient names get canonicalized before matching, how the Tier-1 nutrition seed table is maintained and applied, and how that seed data reaches both dev and prod without conflating it with the separate, dietician-scoped catalog-content migration.

## ADDED Requirements

### Requirement: Ingredient names are canonicalized before FoodItem matching
Since `FoodItem` matching is an exact case-insensitive string match on `Recipe.ingredients[].name` (no alias resolution at match time), any dietician's recipes SHALL be run through the canonical-ingredient migration to rewrite raw ingredient names/categories to their canonical spelling before nutrition coverage is judged against that dietician's catalog.

#### Scenario: Migration targets a specific dietician
- **WHEN** the canonical-ingredient migration script is run with a `--dietician-email=` flag
- **THEN** it rewrites ingredient names/categories only for that dietician's recipes, leaving other dieticians' recipes untouched

#### Scenario: Already-canonical names are a no-op
- **WHEN** a recipe's ingredient name already matches its canonical spelling exactly
- **THEN** the migration makes no change to that ingredient entry

#### Scenario: Unrecognized name is reported, never guessed
- **WHEN** an ingredient name matches neither a canonical name nor any known alias
- **THEN** the migration reports it as unresolved for manual review rather than fuzzy-matching or silently leaving it as-is without surfacing it

### Requirement: New ingredients get both a canonical entry and Tier-1 nutrition data
Any ingredient name found with no matching `FoodItem` and no resolvable canonical alias SHALL get a new `CANONICAL_INGREDIENTS` entry (category, realistic `unitConversions`) and a matching `FOOD_ITEM_NUTRITION_DATA` entry (per-100g calories/protein/carbs/fats/fiber), using the same approximate IFCT/USDA-style sourcing convention already documented on those tables.

#### Scenario: Coverage audit drives the gap list
- **WHEN** `scripts/audit-fooditem-nutrition-coverage.js` reports an ingredient with no matching `FoodItem`
- **THEN** it is either resolved via canonicalization (if an existing canonical entry already covers it) or added as a new canonical + nutrition entry, never left unaddressed without explanation

#### Scenario: Supplement ingredients are out of scope
- **WHEN** an unmatched ingredient belongs to a `category: 'Supplements'` recipe
- **THEN** it is not added to the Tier-1 nutrition table, since Supplements recipes use `supplementFacts` instead of ingredient-level nutrition resolution

### Requirement: Tier-1 seed data can reach both dev and prod
The `FoodItem` Tier-1 seed script SHALL support writing to a second, prod database connection when prod credentials are explicitly provided via environment variables, independent of the dietician-scoped `migrate-dev-catalog-to-prod.js` path (which does not cover `FoodItem`, since it is global data with no dietician to remap).

#### Scenario: Prod write requires explicit credentials
- **WHEN** the seed script is run without `PROD_MONGODB_URI` set
- **THEN** it writes to dev only and never silently guesses or defaults a prod connection

#### Scenario: Prod write is a straight upsert, not a diff-migration
- **WHEN** the seed script is run with `PROD_MONGODB_URI` (and `MONGODB_TLS_CA_BASE64` if required) set and `--execute`
- **THEN** it upserts the same Tier-1 entries into prod's `FoodItem` collection by `normalizedName`, with no dietician-remapping logic (since `FoodItem` carries no dietician reference)

#### Scenario: Prod execution is an explicit handoff
- **WHEN** this change is applied in an environment without network access to prod's private-subnet database
- **THEN** the prod-targeting command is documented and handed off for execution in an environment that does have access, rather than attempted and failing silently
