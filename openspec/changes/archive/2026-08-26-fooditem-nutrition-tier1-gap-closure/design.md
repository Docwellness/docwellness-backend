## Context

See proposal.md - Why/What Changes. Key facts this design relies on:
- `services/recipeVersioningService.js`'s `syncV1FromRecipe` matches `FoodItem.normalizedName` against `normalize(ingredient.name)` from `utils/ingredientLibrary.js` — a plain `trim().toLowerCase()`, no alias resolution. `canonical-ingredients-data.js`'s `aliases` arrays are only consulted by the separate `migrate-canonical-ingredients.js` rewrite script.
- `migrate-canonical-ingredients.js` is hardcoded to `DIETICIAN_EMAIL = 'localdietician@dev.local'` and has never been run against `tejasvini@docwellness.fit` — the dietician every recipe added this session belongs to.
- `migrate-dev-catalog-to-prod.js`'s `INCLUDE_MODELS` is dietician-scoped catalog content (`Recipe`, `Ingredient`, `Article`, etc.) with an explicit natural-key diff strategy per model. `FoodItem` has no `dieticianId` field at all (per `models/FoodItem.js`) and isn't in that list — it needs its own, simpler path (global upsert, no diffing against a dietician's existing prod documents).
- Prod's MongoDB is a private-subnet Oracle VM (`docs/db-migration-oracle.md`) with no public IP; `PROD_MONGODB_URI`/`MONGODB_TLS_CA_BASE64` aren't in this local `.env` and this session has no path to reach it.

## Goals / Non-Goals

**Goals:**
- Close the real 74-ingredient nutrition-data gap with accurate-enough (IFCT/USDA-approximate) figures, matching the existing table's own documented precision level.
- Fix the 3 canonicalization gaps at the source (rewrite the recipe's ingredient name) rather than adding duplicate `FoodItem` entries under alias spellings.
- Make prod-reachability an explicit, correctly-labeled handoff, not a silent gap or a failed attempt.

**Non-Goals:**
- Building a general alias-resolution layer into `syncV1FromRecipe`'s matching (would be a bigger, riskier change touching a hot path many other things depend on) — canonicalizing the data at rest is the existing, established pattern and this change follows it.
- Reaching 100% coverage. Some ingredients may still land below the 90% gate on this pass (see Migration Plan) if further gaps are found once the new entries are in; this change reports the actual resulting number honestly rather than promising 90%+ in advance.
- Migrating `FoodItem` data for the OTHER concurrent session's contaminated-recipe work (Matki Usal/Veg Usal/Varan fixes) — out of scope, unrelated.

## Decisions

**Canonicalization migration gets a `--dietician-email=` flag, not a hardcoded second constant.**
A flag matches the existing dry-run/`--execute` argument convention already used across every script this session touched, and doesn't require choosing between two dieticians going forward — any future dietician's catalog can reuse the same script.

**New canonical/nutrition entries are added as real table rows in the existing files, not a separate "batch 2" table.**
`CANONICAL_INGREDIENTS` and `FOOD_ITEM_NUTRITION_DATA` are meant to be the single source of truth per their own header comments; a parallel table would fragment lookups and require `seed-food-item-nutrition.js` to merge two sources for no benefit.

**Prod write is a new, narrow code path in `seed-food-item-nutrition.js`, not a reuse of `migrate-dev-catalog-to-prod.js`.**
`FoodItem` has no dietician to remap and no natural-key-diff-against-existing-prod-dietician-content need — it's the same global table everywhere. Bolting a diff-migration abstraction built for dietician-scoped content onto global data would be more complex than the problem requires. The new path: connect to `MONGODB_URI` (dev, always) and optionally a second `mongoose.createConnection(PROD_MONGODB_URI, ...)` (using `connectDB.resolveTlsCAFile()` exactly like `migrate-dev-catalog-to-prod.js` does), then run the same upsert-by-`normalizedName` loop against whichever connections are active.

**Prod execution is task-list output, not something this session runs.**
No `PROD_MONGODB_URI`/`MONGODB_TLS_CA_BASE64` exist in this local environment, and prod's DB has no public IP. The final task presents the exact command; running it happens wherever the user actually has network access (SSH'd into the app VPS, or a Coolify one-off command against the deployed environment, which already has both env vars set for the running app).

## Risks / Trade-offs

- [IFCT/USDA-approximate nutrition values for 74 ingredients, hand-compiled without a live lookup, carry the same "not lab-tested" caveat the existing 111-entry table already documents] → Mitigation: explicitly reuses that file's own documented caveat rather than presenting new entries as more authoritative than the existing ones; good enough for diet-plan-level guidance, same bar as what's already there.
- [Running `migrate-canonical-ingredients.js` against `tejasvini@docwellness.fit` for the first time could surface unexpected `UNRESOLVED` names beyond the 3 already identified, since it scans the dietician's full corpus, not just the audit's flagged list] → Mitigation: dry-run first (existing convention), review the unresolved list before `--execute`.
- [A recipe's ingredient array is matched to `Recipe.translations[lang].ingredients[]` by array index (per that script's own header comment) — any bug in the rewrite could desync a translation] → Mitigation: this is pre-existing, tested machinery (already run successfully for the other dietician); not modifying its core rewrite logic, only adding a parameterized dietician selector.

## Migration Plan

1. Run `node scripts/migrate-canonical-ingredients.js --dietician-email=tejasvini@docwellness.fit` (dry run), review the diff and any UNRESOLVED names.
2. `--execute` it.
3. Add the 74 new `CANONICAL_INGREDIENTS` + `FOOD_ITEM_NUTRITION_DATA` entries.
4. Extend `scripts/seed-food-item-nutrition.js` with the optional prod connection.
5. Re-run `node scripts/seed-food-item-nutrition.js --execute` (dev only — no `PROD_MONGODB_URI` set here).
6. Re-run `node scripts/backfill-recipe-versions.js --execute`.
7. Re-run `node scripts/reportFoodItemNutritionCoverage.js` and `node scripts/audit-fooditem-nutrition-coverage.js`, report the actual resulting coverage number.
8. Present the exact prod command (`PROD_MONGODB_URI=... MONGODB_TLS_CA_BASE64=... node scripts/seed-food-item-nutrition.js --execute --prod`) for the user to run from an environment with real prod access. Not executed by this change.
