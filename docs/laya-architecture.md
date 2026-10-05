# Laya integration — architecture

See `docs/laya-integration-analysis.md` for the current-state analysis this design is
built on. This document covers `services/layaDecisionService.js`'s contract and how it
is intended to plug into the existing recipe/diet-plan flow — the "intended" call sites
below are **not wired in Stage A**; nothing under `controllers/` or `routes/` imports
this service yet.

## `layaDecisionService.js` API surface

CommonJS module (matches `services/recipeSelectionEngine.js`,
`services/nutritionCalculatorService.js` — no class-based services exist in this
codebase). Exported functions:

- `classifyRecipe({ recipe })` — soft classification (`meal_type_fit`, `protein_level`).
  Deliberately does not ask about allergens/dietaryHabits — those are already
  deterministic (see analysis doc).
- `scoreRecipe({ recipe, criteria })` — a single 0-1 suitability score.
- `checkRecipeCompatibility({ recipe, userProfile })` — a soft preference-fit signal,
  explicitly not a safety check (allergen conflicts are already excluded before a
  recipe reaches this call).
- `classifyUserIntent({ text })` — routes free text to `recipe_request` /
  `diet_plan_request` / `question` / `other`.
- `shouldRegenerate({ validationSummary })` — one more input into the *existing*
  generation retry loop (see below), never a second loop.
- `requiresDieticianReview({ decisionSummary })` — one more signal feeding the
  *existing* `DietPlan.riskFlags`/`validationWarnings` review surface, never a new
  review-queue model.

## Fail-safe contract

Every function resolves — never throws — one of:
```js
{ ok: true, answers, usage, latencyMs }
{ ok: false, reason: 'disabled' | 'timeout' | 'error', detail? }
```
`reason: 'disabled'` is returned immediately, with no network call, whenever
`config.laya.enabled` is false (the default). This is the entire kill switch: no caller
needs its own `if (config.laya.enabled)` guard, and no caller needs a try/catch to stay
safe if Laya is unreachable.

## Non-goals (do not implement these against Laya)

- No free-form generation. Recipes and diet plans are generated exclusively by
  `utils/openaiClient.js`.
- No nutrition math. Calories/macros stay with `services/nutritionCalculatorService.js`
  and `models/FoodItem.js`.
- Not the sole authority on safety-critical restrictions. Allergen/medical-restriction
  decisions stay with `utils/dietaryConstraintValidator.js` and the deterministic
  exclusion logic already in `runDietPlanGeneration` (`findAllergenConflicts`). A Laya
  `checkRecipeCompatibility` answer is one *additional* soft signal, combined with,
  never substituted for, those checks.
- Laya's confidence is not proof of correctness. It is one input into whatever review
  policy `requiresDieticianReview` feeds — see the review-gating section below.

## Planned call site: diet-plan generation (Stage B, not wired yet)

`controllers/dietician/dietPlanController.js`'s `runDietPlanGeneration` already has an
outer, content-aware retry loop:

```js
const MAX_GENERATION_ATTEMPTS = 3;         // line 1027
for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {  // line 1051
  // ... generate → parse → validateDietPlan → repairStructuralIssues → revalidate ...
  if (!validationResult.hasSevereIssues) break;
  if (attempt === MAX_GENERATION_ATTEMPTS) break;
  correctiveNote = formatSevereIssuesForPrompt(validationResult.severeIssues);
}
```

### Why one loop, not two

The original spec for this integration proposed a separate `MAX_REGENERATIONS` bound
around Laya's own regeneration signal. That is rejected in favor of a single loop:
`shouldRegenerate` becomes one more input consulted **inside** the loop above (e.g.
after `validateDietPlan` runs each attempt, when `config.laya.mode === 'live'`), able to
turn a would-be-accepted attempt into another retry, but never able to extend the total
attempt count past `MAX_GENERATION_ATTEMPTS`. Two independently-bounded retry loops
around the same OpenAI call would risk unbounded worst-case latency (3×2 attempts) and
confusing double-logging into `GenerationLog`/`correctiveNote`. `MAX_GENERATION_ATTEMPTS`
remains the single source of truth for how many attempts a generation can take.

### Shadow mode (Stage B)

`LAYA_MODE=shadow`: the call above (and any recipe-generation equivalent) runs, its
answer is written to the new `GenerationLog.laya*` fields, but the decision it returns is
never consulted by `validationResult`/`correctiveNote`/`riskFlags` — the response the
user/dietician sees is byte-identical to what it would be with Laya absent. Only once
shadow-mode results have been reviewed against `docs/laya-evaluation.md`'s dataset does
`LAYA_MODE=live` become appropriate, and only then does `shouldRegenerate`/
`requiresDieticianReview` actually influence behavior.

## Review-gating target: `DietPlan.riskFlags` / `validationWarnings`

`models/DietPlan.js` already has `riskFlags[]` and `validationWarnings[]`, populated in
`runDietPlanGeneration` (lines 1215-1216) and surfaced to the dietician before
finalize — this is the existing "human review" mechanism, not a model to duplicate. A
future `requiresDieticianReview` signal (`live` mode only) appends a string like
`laya:requires_review:<reason>` into `newRiskFlags` before that merge, the same way
`isMinor`/`highProteinForWeight` are appended today (lines 1160-1187).

## Decision log: `GenerationLog` extension

`models/GenerationLog.js` already exists as a write-only audit trail per recipe/
diet-plan generation call, explicitly described in its own header as scaffolding for
"future observability/eval work... instead of starting from zero." Stage A adds
additive, default-null fields (`layaMode`, `layaDecisions`, `layaLatencyMs`,
`layaConfidence`, `layaTimedOut`) rather than a parallel collection. Stage B is what
actually writes to them, alongside the existing `GenerationLog.create(...)` calls at
`dietPlanController.js:1122` and `:1225`.

## Recipe-generation call site (Stage B, not wired yet)

`controllers/dietician/uploadRecipieController.js:generateRecipeWithAI` has an
equivalent, simpler shape (single OpenAI call, no outer retry loop today). A shadow-mode
`classifyRecipe` call after generation, logged the same way, is the natural first
integration point there — deferred to Stage B alongside the diet-plan wiring.

## Stage B status: shadow wiring (implemented)

`services/layaShadowService.js` (`runShadow`) is wired at exactly two call sites, both
fire-and-forget and invisible to the response:

| Surface | Where | Laya call | Stored `reference` for comparison |
|---|---|---|---|
| `recipe_classification` | `uploadRecipieController.generateRecipeWithAI`, after the success log | `classifyRecipe` | the `servingTime` the dietician requested |
| `diet_plan_review` | `dietPlanController.runDietPlanGeneration`, after the success log | `requiresDieticianReview` | the deterministic `riskFlags`, warning count, attempts used |

Nothing is shadowed unless `LAYA_ENABLED=true`, `LAYA_MODE=shadow` and the surface is in
`LAYA_SHADOW_SURFACES`. `tests/layaDecisionService.test.js` pins that only these two files
use Laya and never `await` it. `shouldRegenerate`/`requiresDieticianReview` still have no
live (`LAYA_MODE=live`) effect anywhere.
