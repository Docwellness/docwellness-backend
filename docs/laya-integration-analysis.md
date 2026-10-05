# Laya integration — analysis (Stage A)

This document records the current state of the backend before any Laya integration
work, so later decisions can be checked against reality rather than assumption. It
also corrects two factual errors in the original architecture sketch this integration
was proposed from: the existing LLM is **OpenAI**, not Claude/Bedrock, and the database
is **MongoDB**, not PostgreSQL.

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

## Expected CPU/RAM impact

Cannot be determined from this repository — this session has no access to the Oracle
VM's actual vCPU/RAM allocation. `docs/laya-deployment.md` documents this as an
operator-executed step: inspect the real VM's resources before setting `LAYA_THREADS`,
and load-test (1/5/10/20/50 concurrency) before trusting any latency number from Laya's
own published benchmarks, which were not measured on this hardware.
