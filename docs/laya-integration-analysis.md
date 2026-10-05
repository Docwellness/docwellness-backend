# Laya integration — analysis (Stage A)

This document records the current state of the backend before any Laya integration
work, so later decisions can be checked against reality rather than assumption. It
also corrects two factual errors in the original architecture sketch this integration
was proposed from: the existing LLM is **OpenAI**, not Claude/Bedrock, and the database
is **MongoDB**, not PostgreSQL.

> **Reading note.** This was written at Stage A and is kept as the record of that state.
> Paragraphs headed **Status (2026-10-05)** were added after Stage B (Laya deployed, shadow
> mode live on one surface) to say what has changed. Day-to-day operation is in
> `docs/laya-operations.md`.

## Current architecture

- **Framework**: Node.js (>=22), Express 5, CommonJS (no TypeScript).
- **Database**: MongoDB via Mongoose (`models/*.js`, registered in `models/index.js`).
  No formal migration tool — schema changes are additive fields with defaults,
  reconciled via `Model.syncIndexes()`; one-off data migrations are plain scripts in
  `scripts/`.
- **Deployment**: dev → Vercel serverless (`api/index.js`, `vercel.json`). Prod → a
  single-container Coolify deployment on an Oracle Cloud "Always Free" VPS (`Dockerfile`,
  `node:22-slim`, `CMD node app.js`), behind Coolify's managed Traefik reverse proxy.
  **No `docker-compose.yml` drives production today** — this matters for how Laya gets
  deployed (see `docs/laya-deployment.md`).
- **Redis**: optional (`utils/redisClient.js`, no-ops when `REDIS_URL` unset) — used for
  Socket.IO cross-instance pub/sub, response caching, rate-limiting, and a minimal
  custom Redis-list job queue (no Celery/BullMQ).
- **Auth**: Supabase-issued bearer tokens (`middlewares/auth.js`), roles
  patient/dietician/admin (`middlewares/roleCheck.js`). Internal cron-style endpoints
  use a separate `CRON_SECRET` shared-secret scheme (`routes/internal.js`).
- **Feature flags**: no flag service exists — only plain env-var toggles read once in
  `config/environment.js` (e.g. `DIET_PLAN_ENGINE`, `DIET_PLAN_DATA_MODEL`). `LAYA_ENABLED`/
  `LAYA_MODE` follow this same pattern.

## Current AI flow

- **LLM**: OpenAI (`gpt-4o`), via `utils/openaiClient.js` (`openai.responses.create`
  with structured `json_schema` output, `chat.completions.create` fallback,
  deterministic seeding, 2-attempt inner retry for transport/refusal errors).
- **Existing structured-decision precedent**: `utils/jevClient.js` already calls
  TypeSafe's hosted Jev ("System One") API (`POST https://api.typesafe.ai/v1/systemone`,
  bearer auth, `{model, state, questions}` body, `choice`/`score`/`noul` question types)
  for recipe-photo art-direction judgments (`utils/recipeImageGenerator.js`). Since Laya
  speaks the same protocol, `services/layaDecisionService.js` is structured as a sibling
  of this file — same request/response shape, self-hosted base URL, separate key. Jev
  stays scoped to art-direction; Laya is scoped to recipe/diet-plan business decisions.
- **Recipe generation**: `POST /recipes/ai-generate-preview`
  (`controllers/dietician/uploadRecipieController.js:generateRecipeWithAI`) — validates
  fields → `validateRecipeConstraints` → `checkTextSafety` (prompt-injection guard,
  `utils/inputGuardrails.js`) → OpenAI call → deterministic ingredient scaling → returns
  a preview (not persisted until a separate `POST /recipes`).
- **Diet-plan generation**: `controllers/dietician/dietPlanController.js:runDietPlanGeneration`
  — queries a candidate `Recipe` pool (dietary-habits/eating-style filter, allergen
  exclusion via `findAllergenConflicts`) → an outer retry loop
  (`MAX_GENERATION_ATTEMPTS = 3`, line 1027/1051) calls `generateDietPlanWithAI` or a
  deterministic engine (`services/recipeSelectionEngine.js`) → `validateDietPlan`
  (`utils/dietPlanValidator.js`) → structural auto-repair
  (`utils/dietPlanRepair.js`) → re-validate → on repeated failure, re-prompts with a
  corrective note built from validator findings → every attempt logged to
  `GenerationLog`.
- **Validation** (existing, to be reused rather than duplicated):
  `utils/dietPlanValidator.js` (closed-world recipe check, slot correctness, calorie
  tolerance, non-veg day-group gating), `utils/dietaryConstraintValidator.js`
  (allergen/keyword conflicts, Jain/vegan incompatibilities — also auto-derives
  `Recipe.allergens` pre-save from ingredient name matching), `utils/recipeNutritionValidator.js`
  (`checkNutritionPlausibility`), `utils/inputGuardrails.js` (`checkTextSafety`).
- **Audit trail**: `models/GenerationLog.js` — write-only today ("nothing reads this
  yet" per its own header comment), the designated reuse point for a Laya decision log
  rather than a new collection.
- **Human review surface**: no dedicated review-queue model. `DietPlan.riskFlags`/
  `validationWarnings` (populated in `runDietPlanGeneration`, lines 1215-1216) is the
  existing pre-finalize dietician-review surface, and the intended target for a future
  `requiresDieticianReview` signal.

## Relevant files and functions

Existing code the integration touches or deliberately leaves alone:

| File | What it is | Laya relationship |
|---|---|---|
| `utils/openaiClient.js` | OpenAI calls (`generateRecipeWithAI`, `generateDietPlanWithAI`, structured output, inner retry) | **Unchanged.** Generation stays here. |
| `controllers/dietician/uploadRecipieController.js` — `generateRecipeWithAI` | Recipe preview endpoint | Shadow hook `recipe_classification` after the success log. |
| `controllers/dietician/dietPlanController.js` — `runDietPlanGeneration` | Plan generation, `MAX_GENERATION_ATTEMPTS = 3` loop, `GenerationLog` writes | Shadow hook `diet_plan_review` after the success log (surface not enabled in prod). Receives `requestId`. |
| `services/dietPlanGenerationService.js` — `generateWeekPlan` | Engine wrapper (`ai` vs deterministic) | Passes `requestId` through to `runDietPlanGeneration`. |
| `services/recipeSelectionEngine.js` | Deterministic candidate scoring/selection | Unchanged; the natural home for a future Laya filter step. |
| `utils/dietPlanValidator.js`, `utils/dietPlanRepair.js` | Plan validation and structural repair | Unchanged; remain the exact-constraint authority. |
| `utils/dietaryConstraintValidator.js` | Allergen/dietary-habit derivation and conflicts | Unchanged; Laya must not replace it (safety-critical). |
| `utils/recipeNutritionValidator.js`, `services/nutritionCalculatorService.js`, `models/FoodItem.js` | Nutrition plausibility and calculation | Unchanged; Laya never computes nutrition. |
| `utils/inputGuardrails.js` | Prompt-injection / safety text check | Unchanged. |
| `utils/jevClient.js` | TypeSafe Jev client (hosted, art-direction only) | Precedent for the protocol; kept separate from Laya. |
| `middlewares/requestLogger.js` | pino-http; sets `req.id` and `X-Request-Id` | Source of the `requestId` stored on shadow rows. |
| `models/Recipe.js`, `models/DietPlan.js` | Recipe data; `riskFlags`/`validationWarnings` | Read-only inputs; `riskFlags` is the future review-gating target. |
| `models/GenerationLog.js` | Audit trail | Extended with `laya*`, `requestId` and `model` fields for shadow rows. |
| `config/environment.js` | Env-var config | `config.laya` block (enabled, mode, surfaces, URL, key, model, timeout). |

Added for Laya:

| File | Role |
|---|---|
| `services/layaDecisionService.js` | The abstraction and fail-soft HTTP call: `classifyRecipe`, `scoreRecipe`, `checkRecipeCompatibility`, `classifyUserIntent`, `shouldRegenerate`, `requiresDieticianReview`. `validate_diet_plan()` does **not** exist yet. |
| `services/layaShadowService.js` | `runShadow`: fire-and-forget shadow runner; writes shadow rows; swallows every error. |
| `utils/layaEval.js`, `utils/layaLoadTest.js` | Pure logic for evaluation, shadow reporting and load testing. |
| `scripts/laya-*.js` | Shadow report, review-sheet exporter, evaluation runner, load test. |
| `Dockerfile.laya`, `docker-compose.laya.yml` | The Laya image (CPU-only torch, non-root) and a local-dev compose. |
| `tests/laya/README.md`, `tests/layaDecisionService.test.js`, `tests/layaShadowService.test.js`, `tests/layaEval.test.js`, `tests/layaLoadTest.test.js` | Dataset spec and automated tests. |

## Relevant database fields already present

`models/Recipe.js` already has `dietaryHabits` (vegan/jain/vegetarian/nonVegetarian/
eggitarian), `freeFrom` (sugar/salt/processedFood/oil), `dietaryTags[]`, `allergens[]`
(auto-derived), `mealSlotSuitability` (Map, servingTime→weight), `status`
(`Active`/`Archived`, no draft/pending-review workflow). Nutrition is fully in-house —
`services/nutritionCalculatorService.js` (pure functions), `Recipe.nutrition`/
`nutritionPerServing`, and `models/FoodItem.js` for per-ingredient data — no external
nutrition API.

## Proposed integration points (documented now, not wired until Stage B)

- `services/layaDecisionService.js` — the abstraction; nothing outside it calls Laya
  directly.
- Inside `runDietPlanGeneration`'s existing attempt loop (`dietPlanController.js:1051`)
  — `shouldRegenerate` as one more input, never a second retry loop (see
  `docs/laya-architecture.md`).
- `DietPlan.riskFlags`/`validationWarnings` merge (lines 1215-1216) — target for a
  `requiresDieticianReview` signal.
- `models/GenerationLog.js` — extended (Stage A) with additive `laya*` fields, written
  to (Stage B) once a real call site exists.

**Status (2026-10-05).** Two of these are now wired, in **shadow mode only** (Laya's answer is
logged, never used): `classifyRecipe` after recipe generation (surface `recipe_classification`,
enabled in production) and `requiresDieticianReview` after plan generation (surface
`diet_plan_review`, built but **not enabled**). `shouldRegenerate` and the `riskFlags` /
`validationWarnings` merge are **not** wired: they would only act in `live` mode, which is gated
on the evaluation dataset. `validate_diet_plan()`, candidate filtering and
`checkRecipeCompatibility` are not wired anywhere yet.

## Where Laya adds marginal value vs. where it's redundant

Laya's proposed `classify_recipe` task overlaps significantly with fields the codebase
**already computes deterministically**: allergens and `dietaryHabits` are derived from
ingredient-name matching in `utils/dietaryConstraintValidator.js`, not something an LLM
or typed-decision model needs to re-infer. Re-deriving them via Laya would be redundant,
not additive, and — per the project's own instruction — Laya must not be the sole
authority on safety-critical restrictions regardless. Laya's realistic marginal value is
in **softer QA signals** an LLM output doesn't already carry with confidence: meal-type-
fit sanity checks on freshly generated recipes, a protein-level tier, a general
preference-compatibility read, and regeneration/review-gating signals that combine with
(not replace) the existing deterministic validators.

## Risks

- **Redundant computation**: see above — scope Laya's questions away from what
  `dietaryConstraintValidator.js` already answers deterministically.
- **Latency/availability**: Laya must never become a dependency the main request path
  can't proceed without — every call in `layaDecisionService.js` is timeout-bounded and
  fails soft (`{ ok: false, reason, detail }`), never throws.
- **Unproven accuracy**: the base English checkpoint underperforms on typed-decision
  benchmarks; `laya-typed-decisions` (fine-tuned) performs much better on Laya's own
  benchmark, but that benchmark is not evidence of accuracy on Docwellness's actual
  dietician/recipe cases. See `docs/laya-evaluation.md` — no decision may reach `live`
  mode before a Docwellness-specific evaluation exists.
- **Deployment topology**: production has no docker-compose today; Laya as a separate
  Coolify resource requires confirming Coolify's internal-network DNS resolution before
  assuming `LAYA_BASE_URL` will resolve — see `docs/laya-deployment.md`.
- **Secrets**: `LAYA_API_KEY` must go through the same Coolify-UI secrets mechanism as
  every other prod secret — never committed to git.

**Status (2026-10-05).** The deployment-topology risk was real. `LAYA_BASE_URL` set to the app's
bare uuid did **not** resolve (`EAI_AGAIN`), even though both apps are on the same `coolify`
Docker network: Coolify's container name carries a changing suffix, and the working fix was a
**Custom Network Alias** on the Laya app plus a Laya redeploy. Two further risks materialised:
Laya answers one request at a time (concurrent requests queue, then 503), and a client timeout
does not cancel work inside Laya. See `docs/laya-operations.md`.

## Expected CPU/RAM impact

Cannot be determined from this repository — this session has no access to the Oracle
VM's actual vCPU/RAM allocation. `docs/laya-deployment.md` documents this as an
operator-executed step: inspect the real VM's resources before setting `LAYA_THREADS`,
and load-test (1/5/10/20/50 concurrency) before trusting any latency number from Laya's
own published benchmarks, which were not measured on this hardware.

**Status (2026-10-05).** What is now known: the VM has **2 aarch64 cores and ~12 GB RAM** (about
10 GB available at the time of checking), shared with the backend. Laya runs at
`LAYA_THREADS=1`, CPU limit 1.5, memory limit 4 GB; the model used about 2 GB RAM in a local
container (not measured on the VM). Measured call latency on the VM for the real
recipe-classification payload is about **5 s** at 1 thread and about 4.4 s at 2 threads. **Not
yet measured:** concurrency behaviour (1/5/10/20/50), Laya's CPU/RAM on the VM, and backend
latency impact under load. `scripts/laya-load-test.js` exists for this and has not been run
there.

## Deployment architecture (as built, 2026-10-05)

```
                       Internet
                          |
                  Coolify / Traefik (public: backend only)
                          |
 Oracle VM "docwellness-prod"  (2 aarch64 cores, ~12 GB RAM)
 +---------------------------+---------------------------------+
 |  Docker network "coolify"                                   |
 |                                                             |
 |   docwellness-backend --HTTP, bearer--> docwellness-laya    |
 |   (Node 22, public API)  http://docwellness-laya:8000       |
 |                          via Custom Network Alias           |
 |                                          (Python, laya[serve] 0.3.26,
 |                                           CPU-only torch, uid 1000,
 |                                           no public domain or port,
 |                                           volume /models for weights)
 +---------------------------+---------------------------------+
                             | private subnet, TLS
                    MongoDB (separate Oracle VM)
                    shadow rows -> GenerationLog
```

- **Laya** is a second Coolify application in the same project and environment as the backend,
  built from `Dockerfile.laya` (pasted into Coolify's Dockerfile field). It is reachable only on
  the internal Docker network. The public domain Coolify assigns by default is cleared.
- **Resource caps:** `LAYA_THREADS=1`, CPU limit 1.5, memory limit 4 GB, `LAYA_MAX_CONCURRENT=1`,
  `LAYA_PRELOAD=1`. The backend keeps the remainder of the 2 cores.
- **Health:** Laya's `/health`, monitored by Coolify (its restart policy has not been verified here). The health check needs
  `curl` in the image.
- **Failure isolation:** the backend calls Laya fire-and-forget behind a timeout, so Laya being
  down, slow or overloaded cannot affect a response. `LAYA_ENABLED=false` (plus a redeploy)
  removes it entirely.
- **No Redis/PostgreSQL involvement:** Laya has no state beyond its cached model weights.

Details, settings and procedures: `docs/laya-operations.md`.

## Open questions

Decisions or unknowns that the code cannot answer. Each blocks or shapes later work.

**Quality and the gate**

1. **Who sets the accuracy thresholds** for moving past shadow, and per what: per category, per
   field (e.g. `protein_level` separately from `meal_type`)?
2. **Who reviews the 500 examples,** and how much dietician time is available? The exporter
   (`scripts/laya-eval-export-review-sheet.js`) removes the blank-page problem but not the review.
3. **Is `protein_level` worth keeping?** In early shadow data Laya called clearly protein-rich
   dishes "low". It may need a reworded question or to be dropped; the dataset will say.
4. **Which checkpoint is actually answering?** We request `laya-typed-decisions` but Laya's
   router has served `laya-rl-agent` every time. Can the checkpoint be forced? Model comparison
   (`laya` vs `multilingual` vs `typed-decisions`) is only meaningful if it can.
5. **Does Laya add signal beyond the deterministic validators?** For safety-relevant questions
   the existing validators already answer. Shadow data should be checked for cases where Laya
   would have flagged something they missed, before investing in more surfaces.

**Performance and infrastructure**

6. **What latency is acceptable for `live`?** About 5 s per call at 1 thread, one request at a
   time, cannot sit in a request path. Options: a smaller or ONNX-optimised model, more cores, a
   GPU (reportedly declined on cost in another project, where the Oracle account also had no GPU quota), or a dedicated VM.
   Is a second VM acceptable within the Always Free limits?
7. **Should Laya keep sharing the backend's VM at all?** A load test could slow the backend;
   `scripts/laya-load-test.js` aborts on backend `/health` p95, but that only limits the damage.
8. **Pinning model weights.** Weights are downloaded from HuggingFace on first start. Is the
   revision pinned? Unpinned means a restart could pull different weights, and a first start
   depends on HuggingFace being reachable (the `/models` volume mitigates the second).

**Rollout and operations**

9. **How will Phases 5-7 select users?** The only flag mechanism is process-wide env vars.
   "Internal users" and "a percentage of traffic" need a per-user or per-request switch (a
   Mongo-backed flag, or an allow-list), which does not exist yet.
10. **Where should `laya_*` metrics and alerts go?** Nothing is wired. Is there an existing
    destination (e.g. the Sentry already configured, or the request-metrics layer) to reuse?
11. **Retention of shadow rows.** `GenerationLog` is append-only; is a TTL or periodic cleanup
    wanted, and who owns excluding test-account rows from analysis?

**Data and privacy**

12. **`diet_plan_review` and health-adjacent data.** The stored reference now holds only a
    risk-flag count (done 2026-10-05). The summary *sent to* Laya for the call (not stored) still
    contains the flag names (e.g. `isMinor`) and up to 10 warning strings. Is that acceptable for an
    internal service, or must it be generalised before the surface is enabled?
13. **Preference-matching and compatibility datasets** need user-profile fields. Which fields are
    safe to put in a committed test file (the README says no personal health information)?

**Design confirmations**

14. **Regeneration bound.** The plan suggests `MAX_REGENERATIONS=2`; the code keeps the existing
    single loop (`MAX_GENERATION_ATTEMPTS = 3`) as the only bound (see
    `docs/laya-architecture.md`). Confirm this is the intended reading.
15. **Intent routing.** `classifyUserIntent` uses `recipe_request` / `diet_plan_request` /
    `question` / `other`, not the plan's seven categories (`recipe_search`,
    `meal_plan_generation`, ...). Align once there is a real caller to design for.
