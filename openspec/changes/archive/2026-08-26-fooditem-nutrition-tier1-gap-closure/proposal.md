## Why

Following up on the recipe-database work this session (208 recipes now in the `tejasvini@docwellness.fit` catalog), the `FoodItem` nutrition coverage gate that gates `menuGenerationService.js`'s recipe selection sits at 59.8% (113/189 non-Supplement recipes) after the initial Tier-1 seed. 95 ingredient names have no matching `FoodItem`; a precise classification found 18 are out-of-scope Supplements, 3 are canonicalization gaps (not real data gaps), and 74 are genuinely new ingredients needing real nutrition data. This closes that gap on dev and hands off the equivalent step for prod, where `FoodItem` currently has no seed data at all.

## What Changes

- Parameterize `scripts/migrate-canonical-ingredients.js` to accept a `--dietician-email=` flag (defaulting to its current `localdietician@dev.local` for backward compatibility), so it can be run against `tejasvini@docwellness.fit`'s recipes. This fixes 3 recipes' ingredient names to their already-covered canonical spelling ("Green chili"→"Green Chilli", "Coriander"→"Coriander Leaves", "Chickpea Flour"→"Chickpea Flour (Besan)").
- Add 74 new entries to `scripts/canonical-ingredients-data.js` (`CANONICAL_INGREDIENTS`: category + realistic `unitConversions`) and `scripts/foodItemNutritionData.js` (`FOOD_ITEM_NUTRITION_DATA`: per-100g calories/protein/carbs/fats/fiber), matching those files' existing IFCT/USDA-approximate convention, for every genuinely-new ingredient found in the audit.
- Extend `scripts/seed-food-item-nutrition.js` to optionally also write to a second, prod `MongoDB` connection when `PROD_MONGODB_URI` (and `MONGODB_TLS_CA_BASE64`) are set, using the same dual-connection pattern `migrate-dev-catalog-to-prod.js` already established. `FoodItem` needs no dietician remapping (it's global), so this is a straight upsert against a second connection, not a diff-migration — a new, narrower mechanism than `migrate-dev-catalog-to-prod.js`, whose `INCLUDE_MODELS` deliberately excludes `FoodItem`.
- Re-run the seed + backfill against dev, verify coverage, and hand off the exact prod command — prod execution itself is out of this session's reach (private-subnet MongoDB, no credentials here) and is a documented handoff, not something this change executes.

## Capabilities

### New Capabilities
- `food-item-nutrition-catalog`: requirements for the global `FoodItem` nutrition data layer underneath `RecipeVersion` resolution — canonicalization, Tier-1 data seeding, and dev/prod parity for that seed data.

## Impact

- `scripts/migrate-canonical-ingredients.js`: gains a `--dietician-email=` flag.
- `scripts/canonical-ingredients-data.js`, `scripts/foodItemNutritionData.js`: 74 new entries each.
- `scripts/seed-food-item-nutrition.js`: gains optional prod-write support.
- Dev `FoodItem`/`RecipeVersion` data: coverage rises from 59.8% toward (or past) the 90% gate for `tejasvini@docwellness.fit`.
- Prod `FoodItem` collection: currently empty; this change prepares the seed but does not itself write there — see design.md's Migration Plan for the handoff command.
