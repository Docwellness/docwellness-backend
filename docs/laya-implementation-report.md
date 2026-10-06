# Laya integration — implementation report

_As of 2026-10-05. Status: **shadow infrastructure in place; recipe_classification shadowing stopped 2026-10-05; no real traffic yet. Not production-ready
for `live`.**_ This is the report the integration plan (section 31) asks for. It reports what was
measured, says where the measurement is weak, and leaves a field empty where nothing was measured.
Companion docs: `docs/laya-integration-analysis.md`, `docs/laya-architecture.md`,
`docs/laya-deployment.md`, `docs/laya-evaluation.md`, `docs/laya-operations.md`.

## Summary

- **What exists:** Laya runs as a separate, internal-only service on the production Oracle VM. The
  backend calls it through `layaDecisionService` and records its answers in shadow mode for
  recipe classification. Laya never affects a response, and every failure mode seen so far left
  user-facing recipe generation unaffected.
- **What is proven:** the infrastructure, the fail-soft behaviour, the capacity limits, and the
  resource cost (below).
- **What is not proven:** **whether Laya's decisions are accurate.** There is no dietician-reviewed
  dataset, so no accuracy has been measured. All 25 shadow rows so far come from a test account.
- **Verdict:** the shadow infrastructure is operating. `LAYA_MODE=live` is not appropriate and
  would not be viable on this hardware even if accuracy were proven (one request every ~5.5 s).

## Report fields (plan section 31)

```text
Laya version:            laya[serve]==0.3.26 (PyPI), Python 3.12-slim, CPU-only torch (aarch64)
Model:                   requested laya-typed-decisions; Laya's router served laya-rl-agent every call
CPU:                     VM = 2 aarch64 cores shared with the backend. Laya limit 1.5 CPU.
                         Measured: ~140-150% of one core under load (at the limit); ~0.1% idle
RAM:                     VM ~12 GB. Laya limit 4 GB. Measured: ~2.15-2.2 GB under load, ~2.14 GB idle
Threads:                 LAYA_THREADS=1 (effective CPU use ~1.5 cores - see Findings)
Average latency:         5.5 s   (concurrency 1, 20 requests, 80% recipe / 20% review payload mix)
P50:                     5.3 s
P95:                     7.0 s
P99:                     7.1 s   (a second run: 5.6 / 5.4 / 7.2 / 8.0 s)
Error rate:              0% at concurrency 1 (0 of 40 across two runs).
                         Above the concurrency cap, excess requests are refused (HTTP 503) by design:
                         92-99% at 5-50 concurrent clients. Not errors in the failure sense.
Timeout rate:            0% at every level after the concurrency fix (was 92% at 5 clients before it)
Evaluation accuracy:     NOT MEASURED - no reviewed dataset exists
Backend latency impact:  backend /health p95 9-16 ms during load vs 13 ms idle; 33 ms at 50
                         concurrent clients (partly the test's own overhead). No failures.
Fallback behavior:       fire-and-forget behind a timeout; any Laya failure is swallowed. Verified in
                         production through DNS failures, timeouts and 503s: recipes returned 200.
Production rollout:      Phase 4 infrastructure done; recipe_classification shadowing STOPPED 2026-10-05
                         (see Decision below); diet_plan_review built, not enabled; test traffic only.
                         Phases 5-7 not started. diet_plan_review built but not enabled.
```

> **Which configuration these figures describe.** The block above was measured with the original
> 1.5-core setting. The configuration now in production is **single-core** (see "Single-core
> experiment" below): per-call latency is about **8.0 s mean / 7.6 s p50 / 10.0 s p95 / 10.2 s p99**,
> throughput ~8 calls a minute, CPU ~100% of one core, RAM ~2.2 GB, 0 errors at concurrency 1.
> Rerun `scripts/laya-load-test.js` against the current setting before quoting higher-concurrency
> numbers for it.

## What was built

| Area | State |
|---|---|
| Deployment | Separate Coolify app `docwellness-laya`, same project and `coolify` network as the backend. No public domain or port. Reached through a Custom Network Alias. Weights in a `/models` volume. Non-root. |
| Resource caps | `LAYA_THREADS=1`, CPU limit 1.5, memory limit 4 GB, `LAYA_PRELOAD=1`, `LAYA_MAX_CONCURRENT=1`, plus `OMP/MKL/OPENBLAS_NUM_THREADS=1` and `TOKENIZERS_PARALLELISM=false` (single-core configuration, kept 2026-10-05). Backend: `LAYA_TIMEOUT_MS=30000`, `LAYA_SHADOW_MAX_IN_FLIGHT=1`. |
| Abstraction | `services/layaDecisionService.js`: fail-soft calls, short typed functions. `validate_diet_plan()` not written. |
| Shadow mode | `services/layaShadowService.js`: fire-and-forget, per-surface switch, in-flight cap, rows in `GenerationLog` with request id, model, answer, latency, confidence, error. |
| Flags / rollback | `LAYA_ENABLED`, `LAYA_MODE`, `LAYA_SHADOW_SURFACES`, `LAYA_SHADOW_MAX_IN_FLIGHT`. Rollback = `LAYA_ENABLED=false` + backend redeploy; no migration. |
| Tooling | Shadow report, review-sheet exporter (JSON/CSV) and strict importer, evaluation scorer, load test (with drain and backend probe). |
| Tests | Five Laya suites (decision service, shadow service, evaluation, load test, CSV), ~95 tests, passing at last run. |
| Docs | The five required docs plus this report. |

## Load test results (production VM, 2026-10-05)

Payload: three built-in recipe shapes (6, 13, 20 ingredients) and a synthetic ~2 KB review summary,
80/20 mix, through the same `layaDecisionService` path production uses. Each stage waits for Laya
to drain before the next. Client timeout 15 s.

**Run 1** (`LAYA_MAX_CONCURRENT=4`, before the drain step): concurrency 1 was healthy (20/20, mean
5.6 s). At 5 concurrent clients **2 of 25** requests succeeded, 92% timed out, and throughput fell
from 0.18 to 0.03 ok/s. The queue filled with requests the clients had already given up on, and
nothing completed until the load stopped. The concurrency-10 line in this run partly measured that
backlog and is not reliable.

**Run 2** (`LAYA_MAX_CONCURRENT=2`, with drain):

| Clients | OK | Timeouts | Refused (503) | Notes |
|---|---|---|---|---|
| 1 | 20/20 | 0% | 0% | mean 5.5 s, p50 5.3, p95 7.0, p99 7.1, 0.18 ok/s |
| 5 | 2/25 | 0% | 92% | the 2 admitted took ~4.1 s and ~9.5 s |
| 10 | 2/50 | 0% | 96% | same |
| 20 | 2/100 | 0% | 98% | same |
| 50 | 2/250 | 0% | 99.2% | same |

**Run 3** (levels 1, 2, 50; output not retained): used to read CPU and RAM from Coolify's metrics
(below).

**How to read these:**
- **Capacity is about one request per 5.4 s, roughly 11 per minute, whatever the load.** Laya serves
  one request at a time. Above the cap it refuses instantly and keeps serving the admitted ones at
  normal speed.
- **Stages above concurrency 1 measure load shedding, not capacity.** Fast refusals use up the
  request count within seconds, so each had only 2 successes. Their p95/p99 rest on 2 samples and
  are not meaningful.
- **Resource use** came from Coolify's Metrics view, at coarse granularity.

## Production shadow-mode check

Five recipe generations fired at once: Laya was called for **2** (5.5 s and 9.9 s, the second
waiting behind the first); the other **3** were recorded as `skipped` (`shadow in-flight cap
reached (2)`) and never reached Laya. All 5 recipe responses were 200 in 6-10 s. Every row's
`requestId` matched the response's `X-Request-Id`.

## Shadow data so far (not an accuracy measurement)

25 rows, **all from one test dietician account** (excluded from reports with
`--exclude-dietician`). There is no real-usage data.

| Outcome | Rows |
|---|---|
| Succeeded | 15 |
| Failed during bring-up (DNS ×4, timeouts ×2, one before failure reasons were recorded) | 7 |
| Skipped by the in-flight cap | 3 |

Of the 15 successes, Laya's meal type matched the slot the generator was asked for in 14.
**Correction (found 2026-10-05): this figure is not valid.** The requested slot (`servingTime`)
was part of the recipe text sent to Laya, so Laya could read the answer it was being asked for.
It is neither accuracy nor a clean consistency measure, and should be ignored. (The one "miss",
a snack requested as "Evening Snack" that Laya called "dinner", happened even with the slot
visible, which suggests Laya weighs that field lightly, but that is a guess.) **Fixed in code on
2026-10-05:** `classifyRecipe` no longer sends `servingTime`, the review sheet and dataset inputs
never contain it, and the sheet is now blind and shuffled. The fix takes effect when the backend is
redeployed; shadow rows written before that deploy stay contaminated, so use
`scripts/laya-shadow-report.js --since=<deploy time>` for any agreement figure. Laya's `protein_level` answered "low" for several clearly
protein-rich dishes (chicken curry, chole, fish curry, rajma, paneer tikka). That is anecdotal
and small-sample, but it is the kind of disagreement the evaluation dataset exists to quantify.
Laya also warns at startup that this checkpoint's confidence is not calibrated.

## Blind meal-type smoke test (2026-10-05, after the `servingTime` fix)

`scripts/laya-source-agreement.js`: 80 saved recipes (20 per existing slot), Laya asked the
meal-type question one at a time **without** the recipe's slot. The result is **agreement with the
existing slot labels, not accuracy**: those labels can be wrong and many dishes fit several meals.

| | Result |
|---|---|
| Overall agreement | **37 / 80 = 46%** (chance with 4 slots: 25%) |
| By existing slot | dinner 8/20, breakfast 10/20, snack 9/20, lunch 10/20 |
| Lunch and dinner counted as one "main meal" (derived from the confusion table) | 52 / 80 = 65% (always guessing "main meal": 50%) |
| Exact lunch-vs-dinner match where both are main meals | 18 / 33 = 55% (coin flip: 50%) |
| Mean confidence, agree vs differ | 0.022 vs 0.022 (no discriminating signal) |
| Latency (recipe-only request, single-core) | mean 6.3 s, p50 6.2 s, p95 7.4 s; 0 errors, 0 timeouts |

**Reading it.** Better than chance, but weak. Laya answered "lunch" for 29 of 80 recipes (an even
split would be ~20), so it behaves as if lunch were its default. Lunch vs dinner is close to a
coin flip, which is as much a property of the question as of the model (most dishes suit both).
Breakfast and snack were recognised only about half the time. Laya's confidence did not separate
right from wrong answers, so it cannot support review gating. Before the leak fix shadow rows showed
confidences near 0.35; they fall to ~0.02 once the slot is hidden. This is consistent with the
slot having been doing the work, though it is not proof.

**Consequence for the evaluation design (decided 2026-10-05).** A single "best meal" label penalises
Laya for the inherent lunch/dinner ambiguity, and it cannot express drinks or brunch. The question
is now **multi-label over all seven serving slots** (`utils/layaSlots.js`): Laya answers a yes/no
"is this suitable for <slot>?" for each of Morning Drink, Breakfast, Brunch, Lunch, Evening Snack,
Dinner and Night Drink, and the dietician-reviewed dataset lists every slot a recipe suits. Scoring is
per slot (precision/recall) plus whether Laya's top pick is an accepted slot. This replaces the
single-pick `meal_type_fit` question, so the 46% figure above describes the old question. The new
question's latency (eight questions per call) and quality are **not yet measured**.

**Correction to an earlier statement:** this report previously said the system "already models"
multi-slot suitability through `Recipe.mealSlotSuitability`. The field exists, but no recipe
(in the database checked) has more than one slot in it, so it is not evidence of current practice;
it is only a place where reviewed multi-slot judgements could eventually be stored.

## Per-slot smoke test, seven yes/no questions (2026-10-05)

`scripts/laya-source-agreement.js`, 70 recipes (10 per slot, all seven slots), slot hidden from Laya,
seven yes/no ("noul") questions per call. Agreement with existing slot labels, **not accuracy**.

| | Result |
|---|---|
| Latency per call | **mean 28.8 s**, p50 27.7 s, p95 35.5 s, p99 38.6 s (4.6x the old two-question call) |
| Laya rates the existing slot suitable (>= 0.5) | 49 / 70 = 70% |
| Slots it says yes to per recipe | mean 4.87 of 7 (an overall yes-rate of 70%) |
| Its single top pick is the existing slot | 6 / 70 = 9% (chance among 7: 14%) |
| Yes-rate by slot | Morning Drink 86%, Night Drink 83%, Dinner 76%, Lunch 71%, Brunch 69%, Evening Snack 57%, Breakfast 46% |

**Reading it.** The existing slot is rated suitable 70% of the time, which is exactly Laya's base
rate of saying yes, so that figure carries no signal. Top pick was below chance (Morning Drink won
for 9 of 10 dinners). The probabilities cluster near 0.5 (examples 0.36-0.56), so a 0.5 line mostly
splits noise, and the per-slot bias dominates. At 28.8 s a call, with a 30 s timeout, roughly a third
of calls would time out. **This form did not work as built.** What it does not show is whether a
threshold-free reading would find signal that the 0.5 line hides; the rank metrics added afterwards
(`utils/layaRank.js`) are for that.

**Alternative implemented:** the default form is now **one 7-option choice question** (`slot_fit`,
`LAYA_SLOT_MODE=choice`): a probability per slot in about a quarter of the time (local probe ~4 s vs
~10 s for the seven questions; production latency not yet measured). Not yet measured for quality
on the 70 recipes; the seven-question form stays available as `LAYA_SLOT_MODE=noul` for comparison.

## One-question slot form vs a trivial baseline (2026-10-05)

Same 70-recipe design (10 per slot, slot hidden from Laya), `LAYA_SLOT_MODE=choice` (one 7-option
question): **latency mean 10.8 s** (p50 10.6, p95 12.5), no errors. Agreement with existing slot labels,
**not accuracy**. Chance in brackets.

| | Laya (choice form) | Bag-of-words baseline* | Category prior* |
|---|---|---|---|
| Existing slot's mean rank (4.0) | 3.09 | 1.99 | 2.91 |
| In top 1 (14%) | 33% | **47%** | 26% |
| In top 2 (29%) | 44% | **71%** | 54% |
| In top 3 (43%) | 56% | **90%** | 69% |
| Macro AUC (0.50) | 0.75 | **0.86** | n/a** |

\*Trained on the existing labels and scored leave-one-out; run on a sample built the same way as
Laya's (same seed), not necessarily the identical 70 recipes. `scripts/laya-slot-baseline.js --laya=<json>`
scores both on exactly the same ones. \*\*Leave-one-out makes a prior's AUC meaningless.

**Laya's per-slot AUC:** Night Drink 0.95, Morning Drink 0.93, Dinner 0.79, Breakfast 0.72,
Brunch 0.68, Lunch 0.68, Evening Snack 0.52. Its top picks were right mostly for drinks and
breakfast (Morning Drink 10/10, Breakfast 9/10); for lunch, dinner and brunch the top pick was almost
never the existing slot (it favours "breakfast" for most food).

**Reading it.** Laya's serving-slot judgement is clearly better than chance (overall) but, on this
sample, **clearly worse than a few lines of code trained on the existing labels**, and the part it gets
right (telling drinks from food) is largely recoverable from the category and ingredients. The labelled
data has near-duplicate recipes and one set of authors, which flatters any baseline trained on it, so the
baseline's advantage overstates what it would do on genuinely novel dishes; Laya needs no labels. Even so,
for slot assignment Laya is not clearly earning its ~11 s a call. The dietician-reviewed dataset (which
accepts several slots per recipe) is still needed to measure either properly.

**Protein check:** a rank-based comparison of Laya's `protein_level` with the nutrition data's exact
protein per serving is now part of the smoke test (`utils/layaProtein.js`); no result yet, it needs one more
run.

## Decision: stop shadowing recipe_classification (2026-10-05)

`LAYA_SHADOW_SURFACES` was emptied, so nothing is shadowed. Reasons, all measured above:

- **Serving slots:** Laya's judgement beats chance but, on a comparable sample, loses clearly to a bag-of-words
  baseline trained on the existing labels (top-1 33% vs 47%, macro AUC 0.75 vs 0.86). What Laya gets right
  (drinks vs food) is recoverable from the category and ingredients.
- **Protein tier:** it never answered "high" (0 of 15 high-protein recipes), the within-slot correlation was weak
  and inconsistent, and the nutrition data already holds the exact grams (where it is missing, the fix is filling
  the data: 25 of 70 sampled recipes have no protein per serving).
- **Cost:** each shadow call kept Laya busy for ~11 s and produced data of limited use.

Nothing here says Laya is useless: it says it is not earning its place on this question. The dietician review for
slots is on hold. The remaining candidates are decisions with no labelled history to train a baseline on
(compatibility with a user's preferences, review gating), which need their own reviewed datasets.

## Where Laya's tokens go (2026-10-05)

Laya runs on our VM, so its cost is compute, and compute scales with **input tokens**: about 12 ms a
token on a laptop and ~29 ms on the production VM (10.8 s / 376 tokens). Measured against a local Laya on
three representative recipes:

| Request | Input tokens | Time (local) |
|---|---|---|
| Current: slots with descriptions + protein, all ingredients | 376 | 4.6 s |
| Drop the protein question | 238 (-37%) | 2.3 s |
| Slot names only, keep protein | 270 (-28%) | 2.6 s |
| Slot names only, no protein | 132 (-65%) | 1.3 s |
| ... and only the first 5 ingredients | 114 | 1.2 s |
| ... and name + category only | 81 (-78%) | 0.9 s |

The cost is the **question text**, not the recipe: the protein question is ~138 tokens, the seven slot
descriptions ~106, an ingredient ~4. What this does not say is whether the cheaper prompts lose accuracy.
`scripts/laya-prompt-ablation.js` measures tokens and agreement-with-labels together, per variant, on the same
recipes (the slot task is the test case because it has a labelled proxy and a baseline; the surface itself
stays paused). **Results (2026-10-06, 70 recipes, production VM, 0 errors).** Agreement with existing slot labels,
**not accuracy**; the reference variant gave identical numbers in two separate runs (Laya is deterministic).

| Variant | Input tokens | Time per call | Mean rank (chance 4.0) | Top-1 (14%) | Top-2 (29%) | Macro AUC (0.5) |
|---|---|---|---|---|---|---|
| current (descriptions + protein) | 357 | 10.5 s | 3.09 | 33% | 44% | 0.75 |
| no protein | 228 (-36%) | 5.4 s | 3.09 | 33% | 44% | 0.75 |
| slot names only + protein | 251 (-30%) | 5.9 s | 2.49 | 39% | 54% | 0.76 |
| few-word descriptions, no protein | 140 (-61%) | 3.4 s | 3.06 | 29% | 46% | 0.76 |
| slot names only | 122 (-66%) | 3.0 s | 2.49 | 39% | 54% | 0.76 |
| names only, first 5 ingredients | 115 (-68%) | 2.9 s | 2.46 | 37% | 59% | 0.76 |
| **names only, name + category only** | **82 (-77%)** | **2.2 s** | 2.55 | 30% | 60% | **0.77** |
| *bag-of-words baseline (trained on the labels)* | - | - | 2.01 | 49% | 71% | 0.83 |

**What it shows.**
- **More tokens did not buy accuracy here.** Cutting the request by 77% left the AUC at 0.77 (vs 0.75), and
  "slot names only" ranked slightly better than the full descriptions (mean rank 2.49 vs 3.09; top-2 54% vs 44%).
  The differences between variants are small (AUC 0.75-0.77, within noise at this sample size), so read it as
  "the extra text does not help", not "the shortest prompt is better".
- **The protein question has no effect on the slot answers** (identical with and without it) and costs 129 tokens
  (+57% over the no-protein request). Its own results were unchanged by the surrounding text (Spearman 0.51,
  AUC 0.88, within-slot 0.27), and the exact grams are already in the nutrition data.
- **Laya's slot judgement follows the recipe name and category, not the ingredients:** dropping all but five
  ingredients, then all of them, changed nothing measurable.
- **It still loses to the baseline.** The best Laya variants reach AUC 0.76-0.77, top-2 54-60% against the
  baseline's 0.83 and 71% (the baseline, rerun on production data, gives 49% / 71% / 0.83; this settles the earlier
  caveat that it had been run on a local copy).
- **The cost objection is largely removed; the value objection is not.** The cheapest request takes ~2.2 s on the
  VM (about 27 calls a minute instead of 5.7), but a few lines of code trained on the existing labels are still
  more accurate at no compute cost.


## Findings and fixes during rollout

| Issue | Effect | Resolution |
|---|---|---|
| Coolify auto-assigns a public domain to new apps | Laya briefly had a public address | Cleared; verified unreachable |
| Coolify's health check needs `curl`; slim image has none | Deploy marked unhealthy and rolled back | `curl` added to the image |
| Bare app name did not resolve from the backend (`EAI_AGAIN`) | Every shadow call failed | Custom Network Alias, then redeploy of Laya |
| Default 3 s timeout vs ~5 s calls | Every call timed out | `LAYA_TIMEOUT_MS=15000` (acceptable only because calls are fire-and-forget) |
| Client timeout does not cancel work inside Laya | Congestion collapse under bursts | `LAYA_MAX_CONCURRENT=2` and a shadow in-flight cap |
| Shadow rows recorded no failure reason | Failures undiagnosable | `layaError {reason, detail}`, network cause code surfaced |
| `dotenv` banner printed to stdout | Corrupted the first line of CSV exports | Silenced in the exporter |
| `.dockerignore` excluded all of `tests/` | Reviewed datasets would not reach the container | `tests/laya` now ships |
| Laya uses its full 1.5-CPU limit despite `LAYA_THREADS=1` | Three quarters of the VM busy during inference | Open: see below |
| Stage A assumed port 8080 and a `laya-` prefix on `LAYA_MODELS` | Wrong defaults | Corrected (port 8000, short names) |

**Single-core experiment (2026-10-05).** Under load Laya's CPU plateaued at the container limit
(~145%) even with `LAYA_THREADS=1`, because that setting only caps torch's own threads. Adding
`OMP_NUM_THREADS=1`, `MKL_NUM_THREADS=1`, `OPENBLAS_NUM_THREADS=1` and
`TOKENIZERS_PARALLELISM=false` brought CPU to a flat ~100% (one core), confirming the cause. The
cost: per-call latency rose **~45%** (mean 8.0 s vs 5.5 s; p95 10.0 s vs 7.0 s) and throughput fell
from ~11 to ~8 calls a minute. Both configurations spend about 8 core-seconds per call, so Laya
is CPU-bound and speed trades against backend headroom roughly 1:1. Backend `/health` p95 was
unaffected either way. **Decision: single-core was kept (2026-10-05).** Because 2 admitted requests
x ~8 s would exceed the old 15 s timeout, `LAYA_TIMEOUT_MS` was raised to 30000 and both caps were
set to 1 (`LAYA_MAX_CONCURRENT=1`, `LAYA_SHADOW_MAX_IN_FLIGHT=1`). See `docs/laya-operations.md`.

## Definition of done (plan section 30)

| | Item | Status |
|---|---|---|
| ✅ | Separate internal service; not publicly exposed | Done, verified |
| ✅ | Configurable CPU/thread settings; API authentication | Done |
| ✅ | Backend talks to Laya only through `LayaDecisionService` | Done, enforced by a test |
| ✅ | Feature flags; shadow mode; timeouts; fallback; health check | Done |
| ✅ | Rollback by configuration; existing LLM flow works with Laya off | Done |
| ✅ | Automated tests | ~95 tests |
| ✅ | Sensitive information not unnecessarily logged | Shadow rows hold decision metadata only; the diet-plan reference now stores a risk-flag count, not names |
| 🟡 | CPU/RAM load testing | Done, with caveats: built-in fixtures not real DB recipes; stages above 1 client are short |
| 🟡 | Production logging and metrics | Rows and logs exist; **no `laya_*` metrics, no alerting** |
| ❌ | Evaluation dataset | Not started; needs dieticians |
| ❌ | Recipe classification, compatibility and plan validation evaluated | Blocked on the dataset |
| ❌ | Gradual production rollout | Not started |

## Deviations from the plan

- **Shadow before the evaluation dataset.** The plan puts the dataset first. We went to shadow
  without it. The evaluation doc gates `live`, not `shadow`, but it is still out of order.
- **Stack differs from the plan's diagrams:** MongoDB and OpenAI, not PostgreSQL/Redis and Claude.
- **Regeneration bound:** the existing loop (`MAX_GENERATION_ATTEMPTS = 3`) stays the only bound
  rather than a separate `MAX_REGENERATIONS=2`. `shouldRegenerate` is not wired.
- **Not built:** `validate_diet_plan()`, candidate filtering, compatibility wiring, PASS/FAIL/UNCERTAIN
  gating.
- **Manual testing wrote production rows** (all 25), from a test account, to a production database.

## Limits of this report

- One VM, one day, one operator. Latency was measured with fixture payloads.
- CPU and RAM were read from Coolify charts by eye, not from raw time series.
- Run 3's output was not kept; only its resource readings are used.
- Everything about accuracy is **unknown**, not "good" or "bad".

## What would move this forward

1. A dietician-reviewed dataset (500 rows, plan §10) and accuracy thresholds set by the team.
2. Real shadow traffic, analysed with `scripts/laya-shadow-report.js --exclude-dietician=<test id>`.
3. A decision on latency for `live`: this hardware allows ~11 calls a minute, so `live` needs a
   different setup (faster model format, more CPU, GPU, or a dedicated VM). Shadow mode does not.
4. A per-user flag mechanism for the staged rollout, and `laya_*` metrics.
5. (Done) Single-core configuration kept; see `docs/laya-operations.md`.

Do not claim production readiness for `live` until items 1 and 3 are resolved.

## Default prompt changed to `labels_min` (2026-10-06)

Following the ablation above, `classifyRecipe` now sends the `labels_min` request by default (name + category,
slot names only, no protein question): 82 input tokens instead of 357. The old request remains available as
`LAYA_PROMPT_VARIANT=current` (or `labels_protein` to keep `protein_level` at 251 tokens). No surface is shadowed,
so nothing in production changes until shadowing is re-enabled; shadow rows from then on carry no `protein_level`.
