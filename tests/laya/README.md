# Laya evaluation dataset

This folder holds the **dietician-reviewed** examples Laya is scored against, and nothing
else. It is the go/no-go gate in `docs/laya-evaluation.md`: `LAYA_MODE` does not move past
`shadow` until this dataset exists and Laya clears thresholds the team sets.

**The dataset is a human deliverable.** Nothing in this repo generates it, and Claude Code
must not fabricate it. A row counts only when a dietician has filled in `expected` and set
`reviewed_by: "dietician"`. Anything else is reported as "unreviewed" and never scored.

## Layout

```
tests/laya/
  recipe_classification.json   # reviewed examples (committed)
  meal_type.json
  diet_compatibility.json
  preference_matching.json
  review_gating.json
  pending/                     # review sheets awaiting a dietician (git-ignored)
  results/                     # run outputs (git-ignored)
```

Target for the first gate: **100 reviewed examples per category (500 total)**.

## Row format

```json
{
  "id": "optional stable id",
  "input": { "...": "see per-category input below" },
  "expected": { "meal_type": "dinner", "protein_level": "high" },
  "reviewed_by": "dietician"
}
```

| Category | `input` | `expected` | Laya question |
|---|---|---|---|
| `recipe_classification` | `{ recipe: { name, cuisine, category, servingTime, ingredients: [{name}] } }` | `{ meal_type, protein_level }` (either or both) | `classifyRecipe` |
| `meal_type` | same as above | `{ meal_type }` | `classifyRecipe` (meal type only) |
| `diet_compatibility` | `{ recipe, userProfile: { currentEatingStyle, preferences, cravings } }` | `{ compatible: true \| false }` | `checkRecipeCompatibility` |
| `preference_matching` | same as above (preferences/cravings decide the answer) | `{ compatible: true \| false }` | `checkRecipeCompatibility` |
| `review_gating` | `{ decisionSummary: { riskFlags, warningCount, warnings, attemptsUsed, engine } }` | `{ needs_review: true \| false }` | `requiresDieticianReview` |

Allowed values:
- `meal_type`: `breakfast` | `lunch` | `dinner` | `snack`
- `protein_level`: `low` | `moderate` | `high`

`Brunch`, `Morning Drink` and `Night Drink` have no single clean meal type, so they are not
sampled for meal-type examples.

## Do not put personal health information in `input`

Use recipe data and anonymised/generalised profile fields only. No names, contact details,
patient ids, or consultation free text.

## How Laya's answers are read

- **choice** questions (`meal_type_fit`, `protein_level`): the answer's `choice`.
- **noul** (yes/no) questions: Laya returns a probability of "yes" in `[0,1]`
  (observed: `{"type":"noul","noul":0.28}`), not a boolean. The scorer treats
  `>= 0.5` as true (`--noul-threshold` to change it). The right threshold is itself
  something the dataset should inform.
- Errors, timeouts and missing answers are counted as **errors**, not as wrong answers.

## Workflow

1. **Export a review sheet** from real saved recipes (read-only, no DB writes):
   ```
   node scripts/laya-eval-export-review-sheet.js --per-class=25 --seed=1
   ```
   Writes `pending/recipe_classification.pending.json`: real recipes, stratified by meal
   type, with `expected: null`. It deliberately does **not** include Laya's own guess, so
   reviewers aren't anchored. `proposed.meal_type` is just the recipe's existing slot.
2. **A dietician reviews each row**: fills in `expected`, sets `reviewed_by: "dietician"`.
3. **Move the reviewed rows** into `tests/laya/<category>.json`.
4. **Score Laya** (sequential, one example at a time, against a Laya you are happy to load):
   ```
   LAYA_ENABLED=true LAYA_BASE_URL=http://... LAYA_API_KEY=... \
   node scripts/laya-eval-run.js --category=all
   ```
   Compare checkpoints by running once per `--model`. Laya's router may serve a different
   checkpoint than requested; the served model is recorded in the output.
5. **The team sets accuracy thresholds** (`docs/laya-evaluation.md`). This tooling does not.

Existing recipes are not themselves "reviewed" just because a dietician authored them, which
is why step 2 is required before any row counts.

## Shadow-traffic report (not the dataset)

```
node scripts/laya-shadow-report.js --exclude-dietician=<test-account-id>
```

Summarises shadow rows (latency, failures by reason, meal-type agreement). Agreement there
is Laya vs the slot the dietician **requested** - a consistency signal, not accuracy. Use
`--exclude-dietician` to keep test accounts out of the numbers. On production, run it from
the backend container's Coolify Terminal, where the private DB address works.

## Load test (integration plan section 24)

```
node scripts/laya-load-test.js --yes --levels=1,5,10,20,50
```

Run it **in the backend container's Coolify Terminal** (Laya is internal-only, so that is the
only place it is reachable from), at a quiet time: Laya shares the VM's 2 cores with the
backend. It refuses to run without `--yes`.

It sends real-shaped payloads through the same `layaDecisionService` code path production uses,
and while doing so times the backend's own `/health` (idle baseline vs during each stage) to
measure backend impact. It reports per stage: p50/p95/p99, throughput, and error, timeout and
overload rates. It stops escalating if Laya is failing outright or the backend's `/health`
p95 passes `--abort-backend-p95-ms`. Pass `--recipes-file=<review sheet or recipes json>` so
payload sizes match your real recipes.

Reading it:
- `overloadRate` is HTTP 503: Laya refusing work past `LAYA_MAX_CONCURRENT`. Deliberate load
  shedding, not a crash - but in shadow mode that is a dropped decision, and in live mode a
  fallback.
- A client timeout does **not** cancel the work inside Laya: it keeps processing the abandoned
  request, so a burst of timeouts is followed by 503s while it catches up.
- Laya's CPU and RAM are not visible from the script. Read them from the Laya resource's metrics
  in Coolify for each stage's printed UTC window.
- Results go to `tests/laya/results/load-*.json` (git-ignored).
