const config = require('../config/environment');

/**
 * Generation-engine seam. config.dietPlanEngine (DIET_PLAN_ENGINE env var)
 * selects which engine builds new diet-plan weeks: 'ai' (default - the
 * existing OpenAI-driven pipeline, utils/openaiClient.js's
 * generateDietPlanWithAI) or 'deterministic' (the rules-based engine,
 * services/recipeSelectionEngine.js's generateDietPlanDeterministically).
 * Both producers share the exact same input/output contract, so
 * controllers/dietician/dietPlanController.js's runDietPlanGeneration picks
 * between them internally and reuses its retry/validation/repair/merge
 * logic unchanged either way - see that function's `engine` param. Callers
 * go through this single seam instead of picking an engine themselves, so
 * flipping the env var is the entire cutover/rollback mechanism - no code
 * change, no redeploy of anything but config.
 */

async function generateWeekPlan({ dietPlan, dieticianId, weekNumbers }) {
  // Required lazily (not at module top-level) because dietPlanController.js
  // requires this module to call generateWeekPlan, so requiring it back at
  // top-level here would create a circular require and could capture that
  // module's exports object before runDietPlanGeneration is attached to it.
  // By call time (inside a request handler) the app has fully loaded, so the
  // export is guaranteed to be present.
  const { runDietPlanGeneration } = require('../controllers/dietician/dietPlanController');
  return runDietPlanGeneration({ dietPlan, dieticianId, weekNumbers, engine: config.dietPlanEngine });
}

module.exports = { generateWeekPlan };
