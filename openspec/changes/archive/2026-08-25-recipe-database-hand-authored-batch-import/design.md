## Context

See proposal.md - Why/What Changes. This builds directly on `recipe-database-ayurveda-expansion` (archived): same dietician (`tejasvini@docwellness.fit`), same `Recipe` → `RecipeVersion` auto-versioning invariant, same dry-run-first script convention, same `syncV1FromRecipe`-vs-`mongoose.disconnect()` race that change already found and fixed (must be replicated here — see Decisions).

The dataset is 100 recipes; 1 (`Sabudana Khichdi`) exact-name-collides with a recipe already in the catalog (added by the prior change, different slot) and will be skipped by the existing dedup convention, leaving 99 net-new.

## Goals / Non-Goals

**Goals:**
- Import the 99 net-new recipes cheaply and correctly (no AI calls needed - the data is already complete).
- Apply the same Viruddha-fix discipline established by the prior change to whatever this batch's data actually needs, not a token subset.

**Non-Goals:**
- Re-litigating or reopening the archived change's scope or its 18-recipe batch.
- Building a general "is this curd cooked" classifier - each of the borderline cases below is resolved by hand in this design, not by new automation.

## Decisions

**Import goes through `Recipe.create()`, not a hand-rolled `RecipeVersion` insert.**
Same reasoning as the archived change: `Recipe`'s post-save hook (`syncV1FromRecipe`) is the only sanctioned path to a `RecipeVersion`, and it's schema-safe (resolves `foodItemId`, computes `nutritionPerServing`, respects the "never mutate a `PlanItem`-referenced version" invariant) in a way a hand-authored insert is not.

**Explicitly await `syncV1FromRecipe` after each create, same as the last two scripts.**
The archived change found a real bug: the post-save hook is fire-and-forget and can lose a race against `mongoose.disconnect()` for the last document(s) written. `import-hand-authored-recipes.js` reuses the same explicit-await pattern from `add-slot-coverage-recipes.js` from the start, rather than rediscovering the bug.

**Curd-as-fermentation-agent (Methi Handvo, Rava Idli with Coconut Chutney, Oats Idli) gets a non-blocking log, not an ingredient change.**
The prior change's clear-cut fixes were: curd cooked directly into a gravy alongside meat (Chicken Biryani - real Viruddha, meat+curd), and fresh curd kneaded into an unfermented dough that's then pan-fried (Palak Paratha - the curd's only role is moisture, trivially substitutable). These 3 recipes are different in kind: curd/buttermilk as a fermentation or leavening agent in a batter that's steamed or baked is one of the most common and long-established techniques in Indian cooking (idli, dosa, handvo batters routinely include it specifically because fermentation changes what the dairy is - not "heating fresh curd," which is the actual Viruddha concern). Treating this the same as the Palak Paratha case would mean rejecting a huge, normal swath of South Indian/Gujarati cooking on a technicality the classical rule wasn't really aimed at. Given real ambiguity in how strictly to apply the rule here, the design choice is: log it for the dietician (a domain expert) to make the actual call, don't silently alter the dish, and don't silently ignore it either.

**Chamomile Tea with Honey gets the same instructions-only fix as the prior batch's teas.**
Structurally identical to Tulsi Tea/Cinnamon Tea/Fennel Tea (honey stirred into a hot infusion with no cooling step) - same fix, same wording pattern.

**Curd Poha with Pomegranate, Amla and Honey Tonic, and the 4 curd-as-cold-side cases need no fix.**
- Methi Thepla with Curd, Dahi Bhalla, Vegetable Biryani with Raita, Curd Rice: curd is a cold side/topping/mix-in added after cooking, never heated - not a real preparation-order violation, same conclusion already reached for the archived change's 3 chilla recipes.
- Curd Poha with Pomegranate: poha (flattened rice) is softened, not actively cooked with the curd afterward; curd and fruit are mixed in cold - no heat source and no dairy+fruit-in-milk-form concern (curd is not "milk" for the milk+sour-fruit rule, and pomegranate isn't a classically sour fruit like lemon/orange/tamarind).
- Amla and Honey Tonic: ingredients are amla juice, water, and honey with no stated heat step (unlike the teas, which are inherently hot infusions) - reads as a room-temperature/cold tonic, so the heated-honey concern doesn't apply.

**One new script, one new data file, one extended fix table - no new abstractions.**
`scripts/import-hand-authored-recipes.js` mirrors `add-slot-coverage-recipes.js`'s structure minus the AI-generation step. The dataset lives at `scripts/data/hand-authored-batch-1.json` (not inlined in the script - 100 recipes is too much to hardcode as JS literals cleanly). The one new fix (Chamomile Tea with Honey) is added to the existing `INSTRUCTION_FIXES` table in `scripts/fix-viruddha-audit-recipes.js` rather than a parallel fix script.

## Risks / Trade-offs

- [The fermentation-agent judgment call could be wrong for a specific dietician's actual practice] → Mitigation: it's a logged warning, not a silent pass or a silent edit; the dietician sees it and can override either way through the normal recipe-editing UI.
- [100-recipe dataset as a single JSON file is easy to get wrong once] → Mitigation: dry run first, and the import is idempotent (dedup by name), so a partial/failed run is safe to re-run.

## Migration Plan

1. Save the dataset to `scripts/data/hand-authored-batch-1.json`.
2. Run `node scripts/import-hand-authored-recipes.js` (dry run) - confirm 99 planned, 1 skipped (`Sabudana Khichdi`).
3. Run `node scripts/import-hand-authored-recipes.js --execute` - confirm 99 created, 0 failed.
4. Add the Chamomile Tea with Honey entry to `fix-viruddha-audit-recipes.js`'s `INSTRUCTION_FIXES`, dry-run, then `--execute`.
5. Re-export via `scripts/exportRecipesForAudit.js` and confirm catalog is 208 recipes with the fix applied.
