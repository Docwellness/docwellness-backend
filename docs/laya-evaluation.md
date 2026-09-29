# Laya integration — evaluation

## This dataset is a human deliverable, not something Claude Code fabricates

The evaluation dataset described below **must be built from real or dietician-reviewed
examples**. It cannot be synthesized, approximated from existing `Recipe`/`DietPlan`
documents without dietician sign-off, or stubbed with placeholder rows presented as
real data. `LAYA_MODE` must not progress from `shadow` to `live` until this dataset
exists and Laya's measured accuracy against it clears thresholds the team defines
separately (not preset here, since they depend on real results this session cannot
produce). This is a go/no-go gate, not a step this implementation performs.

## Why this gate exists

Laya's own published benchmark shows the base English checkpoint performing poorly on
typed-decision tasks, and the fine-tuned `laya-typed-decisions` checkpoint performing
much better — but that benchmark measures Laya's general typed-decision ability, not its
accuracy on Docwellness's actual dietician/recipe cases. A model that scores well on a
generic benchmark is not thereby proven safe to influence real nutrition/recipe
decisions. The only way to know is to measure it against Docwellness's own data.

## Required dataset

Minimum initial size: **100 examples per category, 500 total**, each with a dietician-
reviewed expected answer:

- Recipe classification (meal-type fit, protein-level tier — matches
  `layaDecisionService.classifyRecipe`'s questions)
- Diet compatibility (matches `checkRecipeCompatibility`)
- Meal-type examples
- User-preference matching
- Review-gating (matches `requiresDieticianReview`)

Each example:
```json
{
  "input": "...",
  "expected": "...",
  "reviewed_by": "dietician"
}
```

Store these under `tests/laya/` once collected, organized by category. Do not mix in
synthetic-only examples as a substitute for real ones — synthetic cases may supplement
but not replace dietician-reviewed ones.

## Model selection

Evaluate, not assume:

1. `laya` (base)
2. `laya-multilingual`
3. `laya-typed-decisions` (fine-tuned)

against the dataset above. `config.laya.model` defaults to `laya-typed-decisions` as the
smallest suitable starting checkpoint per Laya's own benchmark showing it substantially
outperforms the base checkpoint on typed-decision tasks — but this default is a
starting point for evaluation, not evidence of accuracy on Docwellness's own cases. Do
not hard-code model selection in business logic; `LAYA_MODEL` stays configurable exactly
as it is today in `config/environment.js`.

## Comparison template (columns only — no fabricated rows)

| Model | Category | N examples | Accuracy | Notes |
|---|---|---|---|---|
| laya | recipe classification | | | |
| laya-multilingual | recipe classification | | | |
| laya-typed-decisions | recipe classification | | | |
| ... | ... | | | |

## Gate before `LAYA_MODE=live`

1. The 500-example dataset exists, dietician-reviewed.
2. `laya-typed-decisions` (or whichever model wins the comparison above) has been
   measured against it, with accuracy meeting a threshold the team explicitly sets.
3. Shadow-mode results from real production traffic (Stage B) have been reviewed and
   are consistent with the offline evaluation.
4. Load testing (`docs/laya-deployment.md`) confirms acceptable latency/CPU/RAM on the
   actual Oracle VM.

Until all four hold, `LAYA_MODE` stays at `shadow` (or `off`), regardless of how
promising Laya's own general-purpose benchmark numbers look.

## Future fine-tuning (later phase, not this one)

Do not fine-tune Laya initially. First collect real (recipe/diet-plan input, Laya
decision, Laya confidence, dietician decision, final decision) tuples from shadow mode
and — once `live` — from real usage. Only after enough reviewed data exists should a
Docwellness-specific fine-tuning dataset be assembled and evaluated for whether it
provides a meaningful accuracy improvement over `laya-typed-decisions`.
