/**
 * Structured-decision client for Laya - a self-hosted, Jev-compatible typed-
 * decision service (choice/score/noul questions over a JSON "state"). See
 * utils/jevClient.js for the sibling client this mirrors (Jev/TypeSafe,
 * hosted, scoped to recipe-photo art direction - utils/recipeImageGenerator.js).
 * Laya is scoped instead to recipe/diet-plan BUSINESS decisions:
 * classification, scoring, compatibility, and regeneration/review gating.
 * The two never overlap.
 *
 * Non-goals, enforced by what this file deliberately does NOT do: Laya never
 * generates free-form text (recipes, diet plans, prompts) - that stays with
 * utils/openaiClient.js. Laya never computes nutrition (calories/macros) -
 * that stays with services/nutritionCalculatorService.js and the FoodItem
 * database. Laya is never the sole authority on safety-critical restrictions
 * (allergens, medical conditions) - callers must combine its answer with the
 * existing deterministic checks in utils/dietaryConstraintValidator.js and
 * utils/dietPlanValidator.js, never substitute for them.
 *
 * Every exported function is fail-safe: it NEVER throws. If Laya is disabled
 * (config.laya.enabled === false, the default), unreachable, or times out,
 * it resolves { ok: false, reason, detail } so a caller can always fall back
 * to the existing flow without wrapping every call in try/catch. This is
 * what lets Laya be wired into a live request path later (see
 * docs/laya-architecture.md) without risking the flow it's advising.
 *
 * Stage A note (see docs/laya-integration-analysis.md): nothing under
 * controllers/ or routes/ calls this module yet - it exists so the request
 * shape, response contract and fallback behavior are settled and tested
 * before any live traffic depends on them.
 */

const config = require('../config/environment');
const { buildSlotQuestions } = require('../utils/layaSlots');
const { buildProteinQuestion, buildRequest, variantById } = require('../utils/layaPrompts');

async function callLaya({ state, questions }) {
  if (!config.laya.enabled) {
    return { ok: false, reason: 'disabled' };
  }
  if (!config.laya.baseUrl || !config.laya.apiKey) {
    return { ok: false, reason: 'error', detail: 'LAYA_BASE_URL/LAYA_API_KEY not configured' };
  }

  const controller = new AbortController();
  const timeoutMs = config.laya.timeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(`${config.laya.baseUrl}/v1/systemone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.laya.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: config.laya.model, state, questions }),
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      return { ok: false, reason: 'error', detail: `HTTP ${response.status} ${response.statusText} - ${text}` };
    }

    const parsed = JSON.parse(text);
    return { ok: true, answers: parsed.answers, usage: parsed.usage, model: parsed.model, latencyMs: Date.now() - startedAt };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { ok: false, reason: 'timeout', detail: `No response within ${timeoutMs}ms` };
    }
    // Node's fetch reports every network failure as just "fetch failed";
    // the real cause (ENOTFOUND = DNS, ECONNREFUSED, ...) is on err.cause.
    const code = err.cause && (err.cause.code || err.cause.message);
    return { ok: false, reason: 'error', detail: code ? `${err.message} (${code})` : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Soft classification signals for a recipe. Deliberately does NOT ask about
 * allergens or vegan/vegetarian/jain status - Recipe.allergens/dietaryHabits
 * already derive those deterministically from the ingredient list (see
 * utils/dietaryConstraintValidator.js) and re-deriving them via Laya would
 * be redundant, not additive.
 *
 * `servingTime` is deliberately NOT sent. The slot questions below ask which
 * serving slots the recipe suits; sending the slot the recipe was requested for
 * would hand Laya the answer (found 2026-10-05: it was being sent, which made
 * shadow "agreement" figures meaningless). Callers may still pass a recipe that
 * has a servingTime - it is dropped here, so no caller or dataset can leak it.
 */
const DEFAULT_PROMPT_VARIANT = 'labels_min';

async function classifyRecipe({ recipe, slotMode, promptVariant }) {
  const mode = slotMode || config.laya.slotMode || 'choice';
  if (mode !== 'noul') {
    // Default form: one 7-option question, worded by a prompt variant
    // (utils/layaPrompts.js). Default 'labels_min' (name + category, slot names
    // only, no protein): -77% input tokens vs 'current' with no loss of
    // agreement with the existing labels (ablation, 2026-10-06). An unknown
    // id falls back to the default rather than failing the call.
    const wanted = promptVariant || config.laya.promptVariant;
    const id = variantById(wanted) ? wanted : DEFAULT_PROMPT_VARIANT;
    return callLaya(buildRequest(id, recipe));
  }
  return callLaya({
    state: {
      name: recipe.name,
      cuisine: recipe.cuisine || null,
      category: recipe.category || null,
      ingredients: (recipe.ingredients || []).map((i) => i.name),
    },
    questions: {
      // Seven independent yes/no slot questions (slower; see LAYA_SLOT_MODE).
      ...buildSlotQuestions(),
      ...buildProteinQuestion(),
    },
  });
}

/** A single 0-1 suitability score for a recipe against a caller-supplied use case. */
async function scoreRecipe({ recipe, criteria }) {
  return callLaya({
    state: {
      name: recipe.name,
      cuisine: recipe.cuisine || null,
      category: recipe.category || null,
      ingredients: (recipe.ingredients || []).map((i) => i.name),
    },
    questions: {
      suitability_score: {
        type: 'score',
        instructions: criteria || 'How suitable is this recipe for the stated use case, from 0 (not suitable) to 1 (ideal)?',
      },
    },
  });
}

/**
 * Soft preference-fit signal only - NOT a safety check. Allergen/foods-to-
 * avoid conflicts are already excluded deterministically before a recipe
 * ever reaches this call (see dietPlanController.js's findAllergenConflicts
 * usage); this asks a softer "does this generally match their stated
 * eating style/preferences" question a reviewer would combine with, not
 * replace, the deterministic checks.
 */
async function checkRecipeCompatibility({ recipe, userProfile }) {
  return callLaya({
    state: {
      recipe: {
        name: recipe.name,
        dietaryHabits: recipe.dietaryHabits || null,
        freeFrom: recipe.freeFrom || null,
        ingredients: (recipe.ingredients || []).map((i) => i.name),
      },
      userProfile: {
        currentEatingStyle: userProfile.currentEatingStyle || null,
        preferences: userProfile.preferences || null,
        cravings: userProfile.cravings || null,
      },
    },
    questions: {
      compatible: {
        type: 'noul',
        instructions:
          'Based on the stated eating style and preferences (not allergens/medical restrictions, which are checked separately), does this recipe seem like a reasonable fit for this user?',
      },
    },
  });
}

async function classifyUserIntent({ text }) {
  return callLaya({
    state: { text },
    questions: {
      intent: {
        type: 'choice',
        instructions: 'What is the primary intent behind this message?',
        criteria: {
          recipe_request: 'Asking for a specific recipe or dish',
          diet_plan_request: 'Asking for a diet or meal plan',
          question: 'Asking a general question',
          other: 'Something else',
        },
      },
    },
  });
}

/**
 * One more input into the EXISTING retry loop in
 * dietPlanController.js's runDietPlanGeneration (MAX_GENERATION_ATTEMPTS),
 * not a second, independently-bounded loop - see docs/laya-architecture.md.
 */
async function shouldRegenerate({ validationSummary }) {
  return callLaya({
    state: { validationSummary },
    questions: {
      regenerate: {
        type: 'noul',
        instructions:
          'Given this summary of validation findings on a generated recipe/diet plan, would a knowledgeable reviewer consider these issues significant enough to warrant regenerating the content rather than accepting it as-is?',
      },
    },
  });
}

/**
 * One more signal feeding DietPlan.riskFlags/validationWarnings (the
 * existing pre-finalize dietician review surface) - not a new review-queue
 * model. Laya's confidence is one input into that review policy, never
 * treated as proof of correctness on its own.
 */
async function requiresDieticianReview({ decisionSummary }) {
  return callLaya({
    state: { decisionSummary },
    questions: {
      needs_review: {
        type: 'noul',
        instructions:
          'Given this summary, is this a case a dietician should personally review before it reaches the patient, rather than being auto-approved?',
      },
    },
  });
}

/**
 * Send an arbitrary { state, questions } request through the same fail-soft,
 * timeout-bound, authenticated path as every other call. Used by the prompt
 * ablation harness (scripts/laya-prompt-ablation.js) to try prompt variants;
 * production code should use the typed functions above.
 */
async function askLaya({ state, questions }) {
  return callLaya({ state, questions });
}

module.exports = {
  askLaya,
  classifyRecipe,
  scoreRecipe,
  checkRecipeCompatibility,
  classifyUserIntent,
  shouldRegenerate,
  requiresDieticianReview,
};
