## 1. Dataset and import script

- [x] 1.1 Save the 100-recipe dataset to `scripts/data/hand-authored-batch-1.json` and verify it parses: `node -e "console.log(require('./scripts/data/hand-authored-batch-1.json').length)"` → expect 100 — done (100)
- [x] 1.2 Create `scripts/import-hand-authored-recipes.js` mirroring `add-slot-coverage-recipes.js`'s structure (dry-run default, `--execute` to write, skip-if-name-exists per dietician, explicit `await syncV1FromRecipe(...)` after each create to avoid the disconnect race found in the prior change) targeting dietician `tejasvini@docwellness.fit`; verified `node scripts/import-hand-authored-recipes.js` (no flags) prints 99 planned + 1 skipped (`Sabudana Khichdi`) with zero DB writes
- [x] 1.3 Run `node scripts/import-hand-authored-recipes.js --execute` and verify it reports 99 created, 0 failed — done (99 created, 0 failed, no sync-race errors since the explicit `syncV1FromRecipe` await was built in from the start)
- [x] 1.4 Re-run `node scripts/import-hand-authored-recipes.js --execute` and verify it reports 0 created, 100 skipped, confirming idempotency — done (0 created, 0 failed, 100 skipped)

## 2. Viruddha fix for this batch

- [x] 2.1 Add a `Chamomile Tea with Honey` entry to `scripts/fix-viruddha-audit-recipes.js`'s `INSTRUCTION_FIXES` table (same "add honey after cooling" wording pattern as the existing tea fixes) — done
- [x] 2.2 Run `node scripts/fix-viruddha-audit-recipes.js` (dry run) and verify it shows the new instructions-only change for Chamomile Tea with Honey, and 0 changes for the 10 already-fixed recipes — done
- [x] 2.3 Run `node scripts/fix-viruddha-audit-recipes.js --execute` and verify it reports 1 updated, 10 skipped, 0 failed — done (updated=1, skipped=10, failed=0)
- [x] 2.4 Log the non-blocking fermentation-agent note for Methi Handvo, Rava Idli with Coconut Chutney, and Oats Idli (per design.md's Decisions - no ingredient/instruction change, just a recorded note for dietician review); verify by grepping the fix script's run output or a short one-off script that these 3 recipes are flagged — done: added a `FERMENTATION_AGENT_NOTES` list to fix-viruddha-audit-recipes.js that prints a standing review note for all 3 on every run (dry or execute), with zero DB writes; verified output shows all 3, `updated=0`

## 3. Verification

- [x] 3.1 Re-export the full catalog with `node scripts/exportRecipesForAudit.js` and confirm: catalog is 208 recipes (109 + 99), Chamomile Tea with Honey's instructions include the cooling note, and the other 9 previously-fixed recipes are unchanged — done. 208 total, cooling instruction confirmed via direct DB query, all 10 previously-fixed recipes still present.
- [x] 3.2 Run `openspec validate recipe-database-hand-authored-batch-import --strict` and confirm it passes — done
