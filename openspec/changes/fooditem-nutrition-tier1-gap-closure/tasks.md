## 1. Canonicalize tejasvini's ingredient names

- [x] 1.1 Add a `--dietician-email=` flag to `scripts/migrate-canonical-ingredients.js`, defaulting to `localdietician@dev.local` for backward compatibility; verified the script still runs correctly with no flag (dry run, no behavior change for the default dietician — same pre-existing "dietician not found" error as before, confirming no regression)
- [x] 1.2 Run `node scripts/migrate-canonical-ingredients.js --dietician-email=tejasvini@docwellness.fit` (dry run) and review the planned changes and any UNRESOLVED names — done. First pass found 107 unresolved occurrences (77 unique raw names / 74 distinct real ingredients after case-folding) — cross-checked programmatically against the proposal's 74-name list and confirmed an exact match. Also found, via a systematic check against the 111 pre-existing canonical entries, that 7 of the 74 were actually alias gaps on *existing* entries (Bottle Gourd→Doodhi, Rajma→Red Kidney Beans, Dates→Date, Bajra Flour→Bajra (Pearl Millet) Flour, Cumin→Cumin Seeds, Foxnuts (Makhana)→Makhana, Jasmine Rice→Rice), not genuinely new ingredients — fixed via alias additions instead of duplicate entries (see 2.1's note). After adding entries + aliases, re-ran dry run: UNRESOLVED: 0.
- [x] 1.3 Run with `--execute`; verified "Green chili"→"Green Chilli", "Coriander"→"Coriander Leaves", "Chickpea Flour"→"Chickpea Flour (Besan)" are applied and re-running reports no further changes (idempotency) — done: 106 recipes updated, 47 ingredient names changed, 380 categories corrected, 175 Ingredient registry docs upserted; re-run dry-run confirmed 0/189 recipes need further changes.

## 2. Add the 74 missing canonical + nutrition entries

- [x] 2.1 For each of the 74 genuinely-new ingredients (full list in proposal.md), add a `CANONICAL_INGREDIENTS` entry to `scripts/canonical-ingredients-data.js` (category, realistic `unitConversions` for the units it's actually used with) — done, with a scope correction found during 1.2: 7 of the 74 were alias-only fixes to existing entries (see 1.2's note) and 2 more (Corn kernels, Dried chamomile flowers) turned out to be duplicate namings of two of the other 65 rather than distinct ingredients, absorbed as extra aliases on those entries. Net: 65 new `CANONICAL_INGREDIENTS` entries + 7 alias additions to pre-existing entries, closing all 74.
- [x] 2.2 Add a matching `FOOD_ITEM_NUTRITION_DATA` entry to `scripts/foodItemNutritionData.js` (per-100g calories/protein/carbs/fats/fiber, IFCT/USDA-approximate) for each of the same 74; verify `node -e "console.log(Object.keys(require('./scripts/foodItemNutritionData.js').FOOD_ITEM_NUTRITION_DATA).length)"` increased by 74 from its prior 111 — done: 65 new nutrition entries added (matching the 65 new canonical entries, per 2.1's note); verified `CANONICAL_INGREDIENTS` (176) and `FOOD_ITEM_NUTRITION_DATA` (176) are perfectly 1:1 matched with no orphans either direction.

## 3. Extend the seed script for dev/prod

- [x] 3.1 Add optional prod-write support to `scripts/seed-food-item-nutrition.js`: a `--prod` flag that, when set, requires `PROD_MONGODB_URI` (refusing to run without it, same discipline as `migrate-dev-catalog-to-prod.js`) and opens a second `mongoose.createConnection` using `connectDB.resolveTlsCAFile()`; upserts the same Tier-1 entries into that connection's `FoodItem` collection by `normalizedName`, no dietician remapping — done: refactored the upsert loop into a `seedInto(FoodItem, label)` helper called once for dev, and again for a `prodConn.model('FoodItem', FoodItem.schema)` when `--prod` is set
- [x] 3.2 Verify dry run (no `--execute`, no `--prod`) still reports the correct create/update/skip plan against dev only, no prod connection attempted — done (65 to create, 111 to update, dev only)
- [x] 3.3 Verify running with `--prod` but no `PROD_MONGODB_URI` set fails fast with a clear error, not a silent dev-only fallback — done, fails before even connecting to dev

## 4. Re-seed and re-verify on dev

- [x] 4.1 Run `node scripts/seed-food-item-nutrition.js --execute` (dev only) and verify it reports the 74 new creates plus the prior 111 as updates (idempotent upsert) — done: 65 created (matches the corrected new-entry count from 2.1's note; the other 9 of the 74 were alias/duplicate fixes, not new FoodItem rows), 111 updated, 176 total tier1-seed documents
- [x] 4.2 Run `node scripts/backfill-recipe-versions.js --execute` and verify `hasUnresolvedIngredients` count drops accordingly — done: dropped from 76 to 3 unresolved recipes
- [x] 4.3 Run `node scripts/reportFoodItemNutritionCoverage.js` and report the actual resulting coverage percentage for `tejasvini@docwellness.fit` (target: at or above 90%; report honestly if not, per design.md's Non-Goals) — done: 98.4% (186/189), crosses the 90% gate ("1/1 dietician(s) at or above the 90% coverage gate")
- [x] 4.4 Run `node scripts/audit-fooditem-nutrition-coverage.js` again and confirm `missingFoodItemCount` has dropped to (at most) the 18 out-of-scope Supplement items — done: exactly 18, and confirmed by name they are precisely the 18 Supplement-category tablets/capsules identified at the start, nothing else

## 5. Prod handoff

- [x] 5.1 Present the exact ready-to-run prod command and where to run it from — do not attempt to execute it from this session. Done, see below and the final summary message.
- [x] 5.2 Run `openspec validate fooditem-nutrition-tier1-gap-closure --strict` and confirm it passes
