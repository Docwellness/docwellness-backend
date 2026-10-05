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
| `recipe_classification` | `{ recipe: { name, cuisine, category, ingredients: [{name}] } }` (no `servingTime`) | `{ meal_type, protein_level }` (either or both) | `classifyRecipe` |
| `meal_type` | same as above | `{ meal_type }` | `classifyRecipe` (meal type only) |
| `diet_compatibility` | `{ recipe, userProfile: { currentEatingStyle, preferences, cravings } }` | `{ compatible: true \| false }` | `checkRecipeCompatibility` |
| `preference_matching` | same as above (preferences/cravings decide the answer) | `{ compatible: true \| false }` | `checkRecipeCompatibility` |
| `review_gating` | `{ decisionSummary: { riskFlags, warningCount, warnings, attemptsUsed, engine } }` | `{ needs_review: true \| false }` | `requiresDieticianReview` |

Allowed values:
- `meal_type`: `breakfast` | `lunch` | `dinner` | `snack`
- `protein_level`: `low` | `moderate` | `high`

`Brunch`, `Morning Drink` and `Night Drink` have no single clean meal type, so they are not
sampled for meal-type examples.

## Reviewer guidelines (give these to the dieticians)

Consistency between reviewers is what makes the accuracy numbers mean anything.

- **The sheet is blind on purpose.** It does not show the recipe's existing meal slot or meal
  type, and the rows are shuffled, so you decide from the recipe alone. Do not look the slot up.
  (Accepting the existing label would measure agreement with it, not accuracy.)
- **`expected_meal_type`:** `breakfast`, `lunch`, `dinner` or `snack`. The question Laya answers is
  "which meal type does this recipe best fit?" (breakfast: eaten in the morning; lunch: a
  substantial midday meal; dinner: a substantial evening meal; snack: a light dish between meals).
- **`expected_protein_level`** (optional, but needed to score Laya's protein answer). The question
  Laya answers is "how would you characterize this recipe's protein content relative to a typical
  dish of its type?", judged from the ingredient names (Laya is not shown quantities):
  - `low`: little to no significant protein source
  - `moderate`: a moderate protein contribution
  - `high`: a prominent protein source (e.g. meat, fish, legumes, dairy or egg in quantity)
- **`reviewer`:** your name or initials. Required on every row you touch.
- **`review_status`:**
  - `reviewed`: you filled the expected values. This is the only status that is scored.
  - `skipped`: you looked and it should be excluded (a tea, a supplement, a chutney, a raita, a
    papad, a single ingredient). Leave the expected columns empty and say why in `review_notes`.
  - `unsure`: you want a second opinion. Leave the expected columns empty.
  - blank: not reviewed yet. Do not guess to fill a row.
- **`review_notes`:** optional free text. Worth using for hard cases ("a drink named like a meal",
  "fits both lunch and dinner") and for every skipped row.
- Leave `id` and the recipe columns unchanged. Save as CSV (UTF-8) when done.
- Plan for roughly a minute a row.

## What goes in `input` (and what must not)

`input` is exactly what Laya is shown. It must **never contain the answer**:
- **No `servingTime` / meal slot** in `input.recipe`. Laya is asked which meal type a recipe
  fits, so the slot would hand it the answer. (`classifyRecipe` also drops it itself, as a second
  line of defence; it was being sent until 2026-10-05.)
- No Laya output, no reviewer notes.

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

1. **Export a review sheet** from real saved recipes (read-only, no DB writes). On production
   the container's disk is ephemeral, so print it and copy it out:
   ```
   node scripts/laya-eval-export-review-sheet.js --format=csv --stdout --per-class=25
   ```
   Run that in the backend container's Coolify Terminal, copy the CSV (from the `id,name,...`
   header to the last row; the lines about the database connection are not part of it) into a file
   such as `review-sheet.csv`, and open it in a spreadsheet (import as UTF-8).
   The sheet is **blind** (no meal slot, no source meal type), **shuffled** (the sample is grouped
   by meal type, and the order would reveal it), and contains no Laya predictions, so reviewers
   aren't anchored. The recipe's existing slot is not lost: the JSON form
   (`--format=json`) keeps it under `source`, and it stays on the recipe by `id`. `--with-source`
   adds it to the CSV for a non-blind sheet.
2. **A dietician reviews each row** in the spreadsheet (see the reviewer guidelines above): fill
   `expected_meal_type` and optionally `expected_protein_level`, put their name in `reviewer`, and
   set `review_status` to `reviewed`, `skipped` or `unsure`.
3. **Import the reviewed rows** (on a laptop, no database needed):
   ```
   node scripts/laya-eval-import-review-sheet.js --in=review-sheet.csv
   ```
   Writes `tests/laya/recipe_classification.json`, merging by `id`, and lists the rows marked
   skipped or unsure. It is strict: if any row is half-filled or has an invalid value it lists the
   problems and writes **nothing**. The recipe's `servingTime` is never copied into the dataset's
   `input`. Commit the file and redeploy the backend: `.dockerignore` lets `tests/laya` ship in the
   image, so the scorer can read it there.
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
is Laya vs the slot the dietician **requested**. It is only meaningful for rows written **after**
the fix that stopped sending `servingTime` to Laya (2026-10-05; before that Laya could read the
answer, so earlier agreement figures are invalid): pass `--since=<deploy time>`. Use
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
- After every stage the script waits for Laya to **drain** (it keeps working on requests the
  client abandoned), so one overloaded stage does not contaminate the next, or real shadow
  traffic afterwards. It reports `drain` per stage and sets `backlogWarning` if Laya never settled.
- It stops escalating if nothing succeeds because Laya is stalling or erroring; all-503 does
  **not** stop it, since that is deliberate load shedding.
- Laya's CPU and RAM are not visible from the script. Read them from the Laya resource's metrics
  in Coolify for each stage's printed UTC window.
- Results go to `tests/laya/results/load-*.json` (git-ignored).
