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
  meal_type.json               # serving slots only (same expected.suitable_slots)
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
  "expected": { "suitable_slots": ["lunch", "dinner"], "protein_level": "high" },
  "reviewed_by": "dietician"
}
```

| Category | `input` | `expected` | Laya question |
|---|---|---|---|
| `recipe_classification` | `{ recipe: { name, cuisine, category, ingredients: [{name}] } }` (no `servingTime`) | `{ suitable_slots, protein_level }` (either or both) | `classifyRecipe`: seven per-slot yes/no questions plus the protein tier |
| `meal_type` | same as above | `{ suitable_slots }` | `classifyRecipe` (serving slots only) |
| `diet_compatibility` | `{ recipe, userProfile: { currentEatingStyle, preferences, cravings } }` | `{ compatible: true \| false }` | `checkRecipeCompatibility` |
| `preference_matching` | same as above (preferences/cravings decide the answer) | `{ compatible: true \| false }` | `checkRecipeCompatibility` |
| `review_gating` | `{ decisionSummary: { riskFlags, warningCount, warnings, attemptsUsed, engine } }` | `{ needs_review: true \| false }` | `requiresDieticianReview` |

Allowed values:
- `suitable_slots`: any of `morning_drink`, `breakfast`, `brunch`, `lunch`, `evening_snack`,
  `dinner`, `night_drink` (the seven `Recipe.servingTime` values; `utils/layaSlots.js`)
- `protein_level`: `low` | `moderate` | `high`

**Serving slots are multi-label.** A recipe can suit several slots (poha: Breakfast and Brunch; dal:
Lunch and Dinner), and drinks and meals are different kinds of thing, so Laya is not asked "which
ONE meal is this?" (measured 2026-10-05: lunch-biased, lunch vs dinner a coin flip). It is asked, for
each of the seven slots, "is this recipe suitable for it?", and the dataset lists every slot the
dietician accepts. Scoring is per slot (precision, recall) plus whether Laya's top pick is an
accepted slot (`scripts/laya-eval-run.js`).

## Reviewer guidelines (give these to the dieticians)

Consistency between reviewers is what makes the accuracy numbers mean anything.

- **The sheet is blind on purpose.** It does not show the recipe's existing slot, and the rows are
  shuffled, so you decide from the recipe alone. Do not look the slot up. (Accepting the existing
  label would measure agreement with it, not accuracy.)
- **`suitable_slots`: list EVERY slot the recipe would reasonably be served in**, separated by `;`,
  for example `Lunch; Dinner` or `Breakfast; Brunch`. Use these names:
  - `Morning Drink`: a drink taken early in the morning, before or instead of breakfast
  - `Breakfast`: a morning meal eaten at the start of the day
  - `Brunch`: a late-morning meal between breakfast and lunch
  - `Lunch`: a substantial midday meal
  - `Evening Snack`: a light snack or drink between lunch and dinner
  - `Dinner`: a substantial evening meal
  - `Night Drink`: a drink taken at night, before bed
  A slot you do not list means "not suitable". An unknown name is rejected on import (so a typo
  cannot silently become an answer).
- **`expected_protein_level`** (optional, but needed to score Laya's protein answer). The question
  Laya answers is "how would you characterize this recipe's protein content relative to a typical
  dish of its type?", judged from the ingredient names (Laya is not shown quantities):
  - `low`: little to no significant protein source
  - `moderate`: a moderate protein contribution
  - `high`: a prominent protein source (e.g. meat, fish, legumes, dairy or egg in quantity)
- **`reviewer`:** your name or initials. Required on every row you touch.
- **`review_status`:**
  - `reviewed`: you filled the expected values. This is the only status that is scored.
  - `skipped`: you looked and it should be excluded (a supplement, a single ingredient, anything
    that is not a servable item). Leave the expected columns empty and say why in `review_notes`.
  - `unsure`: you want a second opinion. Leave the expected columns empty.
  - blank: not reviewed yet. Do not guess to fill a row.
- **`review_notes`:** optional free text. Worth using for hard cases ("fits both lunch and dinner",
  "a drink named like a meal") and for every skipped row.
- A tea or a side (chutney, raita) is a judgement call: if it would be served in a slot, list that
  slot (a tea is often `Morning Drink`, `Evening Snack` or `Night Drink`); if it would not be served
  on its own at all, mark it `skipped`.
- If your team prefers to answer yes/no for every slot explicitly (so a forgotten slot cannot be
  mistaken for "no"), export with `--slot-columns`: seven `slot_<name>` columns, y or n in each, and
  every one must be answered once any is.
- Leave `id` and the recipe columns unchanged. Save as CSV (UTF-8) when done.
- Plan for roughly a minute a row.

## What goes in `input` (and what must not)

`input` is exactly what Laya is shown. It must **never contain the answer**:
- **No `servingTime` / meal slot** in `input.recipe`. Laya is asked which serving slots a recipe
  fits, so the slot would hand it the answer. (`classifyRecipe` also drops it itself, as a second
  line of defence; it was being sent until 2026-10-05.)
- No Laya output, no reviewer notes.

## Do not put personal health information in `input`

Use recipe data and anonymised/generalised profile fields only. No names, contact details,
patient ids, or consultation free text.

## How Laya's answers are read

- **choice** questions: the answer's `choice` (`protein_level`). The slot question comes in two forms (`LAYA_SLOT_MODE`): the default **one 7-option choice question** (`slot_fit`, a probability per slot, summing to 1), or **seven noul questions** (`slot_<name>`, each an independent probability). `utils/layaSlots.js` reads both into one score per slot; higher = better fit.
- **noul** (yes/no) questions: Laya returns a probability of "yes" in `[0,1]`
  (observed: `{"type":"noul","noul":0.28}`), not a boolean. The scorer treats
  `>= 0.5` as true (`--noul-threshold` to change it). The right threshold is itself
  something the dataset should inform.
- Errors, timeouts and missing answers are counted as **errors**, not as wrong answers.

## Workflow

> **On hold (2026-10-05): do not start the serving-slot review yet.** The slot question lost to a trivial
> baseline and `recipe_classification` shadowing was stopped (see `docs/laya-implementation-report.md`,
> "Decision"). The tooling below stays so the review can be run if the decision changes.

1. **Export a review sheet** from real saved recipes (read-only, no DB writes). On production
   the container's disk is ephemeral, so print it and copy it out:
   ```
   node scripts/laya-eval-export-review-sheet.js --format=csv --stdout --per-class=15
   ```
   Run that in the backend container's Coolify Terminal, copy the CSV (from the `id,name,...`
   header to the last row; the lines about the database connection are not part of it) into a file
   such as `review-sheet.csv`, and open it in a spreadsheet (import as UTF-8).
   Recipes are sampled from **all seven slots** (up to `--per-class` each; some slots have fewer
   recipes). The sheet is **blind** (no existing slot), **shuffled** (the sample is grouped by slot,
   and the order would reveal it), and contains no Laya predictions, so reviewers aren't anchored.
   The recipe's existing slot is not lost: the JSON form (`--format=json`) keeps it under
   `source`, and it stays on the recipe by `id`. `--with-source` adds it to the CSV for a
   non-blind sheet.
2. **A dietician reviews each row** in the spreadsheet (see the reviewer guidelines above): list the
   suitable slots in `suitable_slots`, optionally `expected_protein_level`, put their name in
   `reviewer`, and set `review_status` to `reviewed`, `skipped` or `unsure`.
3. **Import the reviewed rows** (on a laptop, no database needed):
   ```
   node scripts/laya-eval-import-review-sheet.js --in=review-sheet.csv
   ```
   Writes `tests/laya/recipe_classification.json`, merging by `id`, and lists the rows marked
   skipped or unsure. It is strict: if any row is half-filled or has an invalid value (including an
   unknown slot name) it lists the problems and writes **nothing**. The recipe's `servingTime` is
   never copied into the dataset's `input`. Commit the file and redeploy the backend:
   `.dockerignore` lets `tests/laya` ship in the image, so the scorer can read it there.
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
is whether Laya rates the slot the dietician **requested** as suitable (a recipe can suit several,
so it is recall of one known-good slot). It is only meaningful for rows written **after** both the fix
that stopped sending `servingTime` to Laya and the per-slot questions were deployed (older rows have
no slot answers or let Laya read the slot): pass `--since=<deploy time>`. Use
`--exclude-dietician` to keep test accounts out of the numbers. On production, run it from
the backend container's Coolify Terminal, where the private DB address works.

## Smoke test before the review (agreement with existing labels)

```
node scripts/laya-source-agreement.js --yes --slot-mode=choice --per-class=10
node scripts/laya-source-agreement.js --yes --slot-mode=noul   --per-class=10
```

Run it in the backend container's Coolify Terminal (`--dry-run` first to see the sample size). It
samples about 70 saved recipes across all seven slots and asks Laya the slot question for each,
one at a time, **without** the recipe's existing slot. Run both forms on the same sample
(same `--seed`) to compare them:

- `--slot-mode=choice` (default): **one** 7-option question. Laya returns a probability per slot
  (they sum to 1). About a quarter of the cost.
- `--slot-mode=noul`: seven yes/no questions, each an independent probability. Measured on the
  production VM at ~29 s a call, with probabilities clustered near 0.5 and a strong per-slot bias
  (yes to Morning Drink 86% of the time, to Breakfast 46%, whatever the recipe).

The main result is **threshold-free**, because a 0.5 line is meaningless for the choice form and
fragile for yes/no: where the existing slot **ranks** among the seven scores (chance: mean rank
4.0, top-1 14%, top-2 29%), the **per-slot AUC** (do recipes filed under a slot score higher for it
than the others do? 0.5 = no signal, 1.0 = perfect), and top-1 after removing each slot's own bias.
It also prints the per-call latency. Results are saved; re-analyse a saved run without Laya or the
database with `--from=<results.json>`. **The saved file lives on the container's disk and is lost on
any redeploy**, so copy out the output you need (or run the baseline comparison) in the same session.

**This is not accuracy.** The existing slot is just how someone filed the recipe and it is one
acceptable slot, not the only one. Read it as "worth investigating" (rank/AUC near chance) or "not
obviously broken" (clearly better). Only the dietician-reviewed dataset measures accuracy.

## Does Laya beat a trivial baseline? (no Laya time, no dieticians)

```
node scripts/laya-slot-baseline.js --laya=tests/laya/results/<saved smoke-test results>.json
```

Run it in the backend container's Coolify Terminal (it only reads the recipe collection; seconds).
It trains three trivial, non-LLM predictors on the recipes' **existing** slot labels and scores each
**leave-one-out** (every recipe is scored by a model that never saw it): the base rate, the
category's usual slot, and a small bag-of-words classifier over name, category, cuisine and
ingredients. It prints the same rank metrics as the smoke test, on the same recipes when
`--laya` is given, so they can be read side by side. The baselines learned from your labels and
Laya never saw them, so beating them is a high bar; clearly losing to them means Laya's cost
(~11 s a call) needs a different justification. Still agreement with existing labels, not accuracy.
(Base-rate AUC is "n/a" and category-prior AUCs at or below 0.5 are leave-one-out artifacts, not
findings; read the bag-of-words column as the real baseline.)

## Does Laya's protein tier carry information? (no human labels)

The smoke test (`scripts/laya-source-agreement.js`) also compares Laya's `protein_level` answer with
the exact protein per serving in the nutrition data (`Recipe.nutritionPerServing.protein`), with no
gram threshold chosen: Spearman rank correlation, AUC for the highest-protein third vs the lowest
third, tier agreement with the grams tertiles, and the same correlation **within each serving
slot** (because "high protein for a dish of its type" is not raw grams). This says whether the tier
carries information; it is not a case for using Laya for nutrition (the plan keeps that exact).

## The cheapest prompt that keeps its accuracy (token ablation)

Laya runs on our own VM, so its cost is compute, and compute is proportional to **input tokens**
(measured 2026-10-05: ~12 ms a token on a laptop, ~29 ms on the production VM). The tokens are mostly
the **question text**, not the recipe: of the current 376-token request the protein question is ~138
and the seven slot descriptions ~106, while an ingredient costs only ~4 tokens.

```
node scripts/laya-prompt-ablation.js --dry-run            # sample, variants, time estimate
node scripts/laya-prompt-ablation.js --yes                # all variants (~48 min on the VM)
node scripts/laya-prompt-ablation.js --yes --variants=no_protein,labels   # a subset ('current' always runs)
node scripts/laya-prompt-ablation.js --from=<saved .json> --tolerance=0.02
```

Run it in the backend container's Coolify Terminal at a quiet time (shadowing is off, so nothing
competes). It runs the same recipes through stripped-down versions of the slot question
(`utils/layaPrompts.js`: with/without descriptions, with/without the protein question, fewer
ingredients, name+category only; a with-protein variant is kept so its value can be weighed against its
~37% of the cost) and reports per variant: **input tokens per call** (Laya's own usage count),
latency, the threshold-free rank metrics (mean rank, top-1/2, macro AUC) and a bag-of-words baseline
for reference, plus the protein-vs-nutrition check for the variants that ask it. It marks variants
that are **dominated** (another is at least as accurate and no costlier) and recommends the
**cheapest variant within `--tolerance` (default 0.03) AUC of the best**. `current` is, by test,
exactly the request production sends.

The yardstick is agreement with the existing slot labels, **not accuracy**: imperfect, but the same
for every variant on the same recipes, which is what an ablation needs. With ~70 recipes differences
under ~0.04 AUC are within noise; confirm a winner on dietician-reviewed data before relying on it.
The method is generic: add a variant to `utils/layaPrompts.js` (or a new question's variants) to
reuse it for the next Laya question.

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
