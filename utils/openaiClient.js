const crypto = require('crypto');
const OpenAI = require('openai');
const config = require('../config/environment');
const { RECIPE_JSON_SCHEMA } = require('./recipeJsonSchema');
const { DIET_PLAN_JSON_SCHEMA } = require('./dietPlanJsonSchema');
const { DISH_EXTRACTION_JSON_SCHEMA } = require('./dishExtractionJsonSchema');

const openai = new OpenAI({
  apiKey: config.openai.apiKey,
});

// Deterministic seed from the full request so identical inputs sample the
// same way (fixes recipes "fluctuating" - e.g. quinoa quantity flipping
// between 185g and 1 cup - across repeated calls with unchanged input).
// Only the chat.completions fallback accepts `seed`; the Responses API
// (openai.responses.create) has no such parameter as of the installed SDK -
// do not add it there, it would be silently ignored or rejected.
const computeRecipeSeed = ({ name, servingTime, servings, dietaryHabits, freeFrom, aiNote, mode }) => {
  const key = JSON.stringify({ name, servingTime, servings, dietaryHabits, freeFrom, aiNote: aiNote || '', mode });
  return parseInt(crypto.createHash('sha256').update(key).digest('hex').slice(0, 8), 16);
};

// Same rationale as computeRecipeSeed above, applied to diet-plan generation:
// identical patient/strategy/recipe-pool inputs should sample the same way.
// weekNumbers is folded in so generating week 1 alone vs. weeks 1-2 vs.
// weeks 3-4 for the same patient/strategy don't collide on the same seed.
const computeDietPlanSeed = ({
  patientId,
  firstConsultationId,
  calorieStrategy,
  macroStrategy,
  recipeIds,
  weekNumbers,
}) => {
  const key = JSON.stringify({
    patientId: patientId || null,
    firstConsultationId: firstConsultationId || null,
    calorieStrategy,
    macroStrategy,
    recipeIds: [...(recipeIds || [])].sort(),
    weekNumbers: [...(weekNumbers || [1, 2, 3, 4])].sort(),
  });
  return parseInt(crypto.createHash('sha256').update(key).digest('hex').slice(0, 8), 16);
};

const parseJsonFromModelOutput = (rawOutput) => {
  const text = (rawOutput || '').trim();
  if (!text) {
    throw new Error('AI returned empty response');
  }

  // First attempt: direct JSON parse.
  try {
    return JSON.parse(text);
  } catch (_) {
    // Continue with fallback extraction.
  }

  // Remove fenced code blocks if present.
  let cleaned = text;
  if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
  else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
  if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);

  try {
    return JSON.parse(cleaned.trim());
  } catch (_) {
    // Continue with object extraction.
  }

  // Last attempt: extract first JSON object boundaries.
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const candidate = cleaned.slice(firstBrace, lastBrace + 1);
    return JSON.parse(candidate);
  }

  throw new Error('AI returned invalid recipe format');
};

const formatMacro = (value) => (typeof value === 'number' ? `${value}` : 'N/A');

const extractPatientBio = (patient) => {
  const fullName = patient?.profile?.fullName || 'Patient';
  const gender = patient?.profile?.gender || 'Not specified';
  const dob = patient?.profile?.dateOfBirth || 'N/A';
  const health = patient?.healthProfile || {};
  const height = health.height ? `${health.height} cm` : 'N/A';
  const weight = health.weight ? `${health.weight} kg` : 'N/A';
  const bmi = health.bmi ? `${health.bmi}` : 'N/A';
  const primaryGoal = health.primaryGoal || 'Not specified';

  return `Name: ${fullName}\nGender: ${gender}\nDate of Birth: ${dob}\nHeight: ${height}\nWeight: ${weight}\nBMI: ${bmi}\nPrimary Goal: ${primaryGoal}`;
};

const summarizeConsultation = (firstConsultation = {}) => {
  const sections = [
    {
      title: 'Dietary Habits & Allergies',
      data: firstConsultation.dietaryHabitsAllergies,
    },
    {
      title: 'Female-specific Health',
      data: firstConsultation.femaleSpecificHealth,
    },
    {
      title: 'Digestion & Elimination',
      data: firstConsultation.digestionElimination,
    },
    {
      title: 'Sleep & Stress',
      data: firstConsultation.sleepStress,
    },
    {
      title: 'Medications & Supplements',
      data: firstConsultation.medicationSupplements,
    },
    {
      title: 'Lab Reports',
      data: firstConsultation.labReports,
    },
    {
      title: 'Final Notes',
      data: firstConsultation.finalNotes,
    },
  ];

  const legacySummary = sections
    .map(({ title, data }) => {
      if (!data) return `${title}: Not provided.`;
      return `${title}: ${JSON.stringify(data)}`;
    })
    .join('\n');

  // The dynamic consultation form (docx-derived questionnaire, see
  // utils/consultationFormSeed.js) stores all answers here instead of the
  // legacy sections above, which are no longer populated by the current
  // consultation UI.
  const customAnswers = Array.isArray(firstConsultation.customAnswers)
    ? firstConsultation.customAnswers
    : [];
  const customAnswersSummary =
    customAnswers.length === 0
      ? 'Consultation Questionnaire: Not provided.'
      : `Consultation Questionnaire:\n${customAnswers
          .map((a) => {
            const value = Array.isArray(a.value) ? a.value.join(', ') : a.value ?? 'Not provided';
            return `- ${a.label}: ${value}`;
          })
          .join('\n')}`;

  return `${legacySummary}\n${customAnswersSummary}`;
};

const summarizeStrategy = (calorieStrategy = {}, macroStrategy = {}) => {
  const calorieSummary = `Calorie Strategy: name=${calorieStrategy.name || 'N/A'}, budget=${formatMacro(
    calorieStrategy.calorieBudget
  )}, deficit=${formatMacro(calorieStrategy.calorieDeficit)}, weeklyWeightLossKg=${formatMacro(
    calorieStrategy.weeklyWeightLossKg
  )}, durationWeeks=${formatMacro(calorieStrategy.durationWeeks)}`;

  const macroSummary = `Macro Strategy: name=${macroStrategy.name || 'N/A'}, fat%=${formatMacro(
    macroStrategy.fatPercent
  )}, carbs%=${formatMacro(macroStrategy.carbsPercent)}, protein%=${formatMacro(
    macroStrategy.proteinPercent
  )}`;

  return `${calorieSummary}\n${macroSummary}`;
};

const { DAY_GROUPS } = require('./dayGroups');

const buildPrompt = ({
  patient,
  firstConsultation,
  calorieStrategy,
  macroStrategy,
  recipes = [],
  weekNumbers = [1, 2, 3, 4],
}) => {
  const bio = extractPatientBio(patient);
  const consultationSummary = summarizeConsultation(firstConsultation);
  const strategySummary = summarizeStrategy(calorieStrategy, macroStrategy);
  const recipesJson = JSON.stringify(recipes);

  const sortedWeeks = [...weekNumbers].sort((a, b) => a - b);
  const weekLabel = sortedWeeks.length === 1 ? `Week ${sortedWeeks[0]}` : `Weeks ${sortedWeeks.join(', ')}`;
  const weekPlanStubs = sortedWeeks
    .map((w, i) =>
      i === 0
        ? `    {
      "week": ${w},
      "dailyMeals": [
        { "dayGroup": "Monday", "servingTime": "Morning Drink", "recipeId": "<id from recipes>" },
        { "dayGroup": "Monday", "servingTime": "Breakfast", "recipeId": "<id from recipes>" },
        { "dayGroup": "Monday", "servingTime": "Brunch", "recipeId": "<id from recipes>" },
        { "dayGroup": "Monday", "servingTime": "Lunch", "recipeId": "<id of a main dish - sabji/curry>" },
        { "dayGroup": "Monday", "servingTime": "Lunch", "recipeId": "<id of a tags:'side' bread - chapati/bhakri>" },
        { "dayGroup": "Monday", "servingTime": "Lunch", "recipeId": "<id of a tags:'side' recipe - rice>" },
        { "dayGroup": "Monday", "servingTime": "Lunch", "recipeId": "<id of a tags:'side' recipe - dal/varan>" },
        { "dayGroup": "Monday", "servingTime": "Lunch", "recipeId": "<id of a tags:'salad' recipe>" },
        { "dayGroup": "Monday", "servingTime": "Evening Snack", "recipeId": "<id from recipes>" },
        { "dayGroup": "Monday", "servingTime": "Dinner", "recipeId": "<id of a main dish - sabji/curry>" },
        { "dayGroup": "Monday", "servingTime": "Dinner", "recipeId": "<id of a tags:'side' bread - chapati/bhakri>" },
        { "dayGroup": "Monday", "servingTime": "Dinner", "recipeId": "<id of a tags:'side' recipe - rice>" },
        { "dayGroup": "Monday", "servingTime": "Dinner", "recipeId": "<id of a tags:'side' recipe - dal/varan>" },
        { "dayGroup": "Monday", "servingTime": "Dinner", "recipeId": "<id of a tags:'salad' recipe>" },
        { "dayGroup": "Monday", "servingTime": "Night Drink", "recipeId": "<id from recipes>" }
        /* repeat this SAME shape of entries 3 more times, once each for
           "dayGroup": "Tuesday", "Wednesday", "Thursday" - see the day-group
           rules below for what must stay identical vs must differ */
      ]
    }`
        : `    {
      "week": ${w},
      "dailyMeals": [ /* same 4-day-group shape, different recipeId choices for variety across weeks */ ]
    }`
    )
    .join(',\n');

  return `You are an expert Indian dietician. Generate a personalized diet plan for ${weekLabel} only. Each day has 7 meal slots (Morning Drink, Breakfast, Brunch, Lunch, Evening Snack, Dinner, Night Drink). Use ONLY the recipes provided below.

Patient Details:
${bio}

Consultation Summary:
${consultationSummary}

Strategy:
${strategySummary}

Available recipes (JSON array - each has "tags": e.g. ["side"] or ["salad"] for accompaniments, and "servingSize" for its portion):
${recipesJson}

Rules:
- You MUST choose meals only from this recipes array.
- For every meal entry, you MUST use a valid recipe "id" from the list.
- Day-group structure (this is how a real week is actually built - not a simplification you can skip): each week has exactly 4 day-groups - ${DAY_GROUPS.join(', ')}. Monday's meals are also eaten on Friday, Tuesday's on Saturday, Wednesday's on Sunday - Thursday is the only truly unique day. Every "dailyMeals" entry MUST carry a "dayGroup" of exactly one of these 4 values. NEVER generate entries for Friday, Saturday, or Sunday specifically - those days automatically reuse Monday/Tuesday/Wednesday's entries.
- Within a day-group, every entry is fixed (that's the whole point - Monday and Friday eat identically because they share one day-group's entries).
- Across the 4 day-groups, the Lunch and Dinner MAIN dish (the sabji/curry itself, not its sides) must be DIFFERENT in each of the 4 groups - never reuse the same main dish recipeId for Lunch across two different day-groups, and likewise for Dinner. This is what gives the week its variety.
- Morning Drink and any recipe with category "Supplements" (e.g. a multivitamin, whey protein) must use the exact SAME recipeId across all 4 day-groups - these never vary day to day.
- A meal slot is NOT limited to one recipe: you may output multiple "dailyMeals" entries that share the same "dayGroup" and "servingTime" when that's how the dish is actually eaten (see the Lunch/Dinner combo rule below).
- Match servingTime: a recipe whose own "servingTime" is Breakfast may only be used for Breakfast, etc. - EXCEPT recipes tagged "side" or "salad" (their own servingTime is usually "Lunch" but they may be assigned to Lunch, Dinner, or Evening Snack, since a chapati/bhakri/rice/salad naturally accompanies any of those).
- Lunch/Dinner/Evening Snack combo rule: real Indian meals pair one main dish with several accompaniments at once - a full thali is typically sabji/curry + a bread (chapati/bhakri) + rice + dal/varan + salad, all "side" or "salad" tagged and all served alongside the main dish, not just one of them. When your chosen main dish for Lunch, Dinner, or Evening Snack is a component dish (sabji, curry, dal, bhurji, usal) rather than an already-complete one-pot meal (biryani, pulav, khichdi, idli, dosa, uttapa - these last three are already a full meal on their own with their own sambar/chutney, never add chapati/bhakri/rice/dal/salad alongside them), add AS MANY of the fitting "side"-tagged accompaniments (bread, rice, dal/varan) as make sense together as separate dailyMeals entries with the same dayGroup+servingTime, plus a "salad"-tagged recipe where it fits naturally - do not stop at just one side when a bread, rice, and dal/varan would all realistically appear on the same plate. Do not add sides to a main dish that's already a complete one-pot meal. Never output more than 5 entries for the same dayGroup+servingTime pair.
- Create meal sets for exactly these weeks: ${sortedWeeks.join(', ')} - no others.
- If generating more than one week, try to provide variety across them while staying close to the target calorieBudget.
- Distribute calories realistically across meals: lighter for Morning Drink and Night Drink, higher for Lunch and Dinner - remember a Lunch/Dinner combo's total is the SUM of its main dish plus its side(s), so size the main dish accordingly rather than expecting one dish alone to hit the full meal's calorie target.
- Respect dietaryHabits and freeFrom flags according to the patient's profile and consultation notes.

Output Requirements:
- Respond ONLY with JSON in this exact structure (no comments, no extra text):
{
  "weeks": [
${weekPlanStubs}
  ]
}
`;
};

const generateDietPlanWithAI = async ({
  patient,
  firstConsultation,
  calorieStrategy,
  macroStrategy,
  recipes = [],
  weekNumbers = [1, 2, 3, 4],
}) => {
  const prompt = buildPrompt({
    patient,
    firstConsultation,
    calorieStrategy,
    macroStrategy,
    recipes,
    weekNumbers,
  });

  const systemPrompt =
    'You are an expert Indian dietician. Generate personalized diet plans in JSON format only, selecting exclusively from the provided recipe pool.';

  // Computed once and reused across retries/fallback so identical requests
  // stay reproducible - see computeRecipeSeed's comment for why a fresh seed
  // per attempt would defeat the purpose.
  const seed = computeDietPlanSeed({
    patientId: patient?._id?.toString(),
    firstConsultationId: firstConsultation?._id?.toString(),
    calorieStrategy,
    macroStrategy,
    recipeIds: recipes.map((r) => r.id),
    weekNumbers,
  });

  const jsonSchemaConfig = {
    name: 'diet_plan_generation',
    schema: DIET_PLAN_JSON_SCHEMA,
    strict: true,
  };

  let parsedPlan;
  let lastError;
  let refused = false;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await openai.responses.create({
        model: config.openai.dietPlanModel,
        input: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        temperature: 0.4,
        text: { format: { type: 'json_schema', ...jsonSchemaConfig } },
      });

      const part = response?.output?.[0]?.content?.[0];
      if (part?.type === 'refusal') {
        console.error(`generateDietPlanWithAI responses.create attempt ${attempt} refused:`, part.refusal);
        lastError = new Error(`Model refused: ${part.refusal}`);
        refused = true;
        break; // a deterministic refusal will likely repeat - don't retry, fall through to fallback
      }
      const raw = typeof part === 'string' ? part : part?.text || response?.output_text || '';
      parsedPlan = parseJsonFromModelOutput(raw);
      break;
    } catch (error) {
      lastError = error;
      console.error(`generateDietPlanWithAI responses.create attempt ${attempt} failed:`, error.message);
    }
  }

  // Fallback path: chat completions, same schema + seed for consistency.
  if (!parsedPlan) {
    try {
      const fallback = await openai.chat.completions.create({
        model: config.openai.dietPlanModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        temperature: 0.4,
        seed,
        response_format: { type: 'json_schema', json_schema: jsonSchemaConfig },
      });

      const message = fallback?.choices?.[0]?.message;
      if (message?.refusal) {
        console.error('generateDietPlanWithAI chat fallback refused:', message.refusal);
        lastError = new Error(`Model refused: ${message.refusal}`);
      } else {
        parsedPlan = parseJsonFromModelOutput(message?.content || '');
      }
    } catch (fallbackError) {
      lastError = fallbackError;
      console.error('generateDietPlanWithAI chat fallback failed:', fallbackError.message);
    }
  }

  if (refused && !parsedPlan) {
    throw new Error(`AI declined to generate this diet plan: ${lastError?.message || 'policy refusal'}`);
  }

  if (!parsedPlan) {
    console.error('Diet plan generation failed:', lastError?.message || 'Unknown error');
    return JSON.stringify({ weeks: [] });
  }

  return JSON.stringify(parsedPlan);
};

/**
 * Generate or refine a recipe using OpenAI
 *
 * @param {Object} params - Recipe generation parameters
 * @param {string} params.name - Recipe name
 * @param {string} params.servingTime - When the recipe is served (Breakfast, Lunch, etc.)
 * @param {number} params.servings - Number of servings
 * @param {Object} params.dietaryHabits - Dietary restrictions (vegan, jain, vegetarian, etc.)
 * @param {Object} params.freeFrom - Free from restrictions (sugar, salt, oil, processedFood)
 * @param {string} params.aiNote - Custom ingredients/preferences note from user
 * @param {Array} params.existingIngredients - Existing ingredients for update mode
 * @param {Array} params.existingInstructions - Existing cooking steps for update mode
 * @param {Object} params.existingNutrition - Existing nutrition for update mode
 * @returns {Object} Generated recipe with ingredients, nutrition, cooking steps, and warnings
 */
const generateRecipeWithAI = async ({
  name,
  servingTime,
  servings,
  dietaryHabits,
  freeFrom,
  aiNote,
  existingIngredients,
  existingInstructions,
  existingNutrition,
  languages,
}) => {
  const isUpdateMode = existingIngredients || existingInstructions || existingNutrition;
  // Languages to generate translations for (non-English)
  const translationLanguages = (languages || ['English']).filter((l) => l !== 'English');

  // Portion calibration: a recipe represents ONE natural serving of the named
  // dish (e.g. "Paneer Paratha" = one paratha) - it is a catalog item, not
  // sized to any particular patient's calorie needs. Per-patient calorie
  // targeting (BMI/BMR/TDEE-based) happens downstream at diet-plan creation,
  // which adjusts the Servings count for a given recipe to hit the patient's
  // target for that meal slot (e.g. 4 parathas instead of 1) - not by
  // stretching a single serving's ingredient quantities. These bands are just
  // a loose sanity-check so the model picks a realistic natural portion size
  // for the meal type, not clinical fact.
  const SERVING_TIME_CALORIE_BANDS = {
    'Morning Drink': [50, 120],
    Breakfast: [250, 400],
    Brunch: [300, 450],
    Lunch: [450, 650],
    'Evening Snack': [100, 200],
    Dinner: [400, 600],
    'Night Drink': [50, 120],
  };
  const calorieBand = SERVING_TIME_CALORIE_BANDS[servingTime] || [200, 500];

  // Build dietary restrictions string for context
  const dietaryList = [];
  if (dietaryHabits?.vegan) dietaryList.push('Vegan');
  if (dietaryHabits?.jain) dietaryList.push('Jain (no onion, garlic, root vegetables)');
  if (dietaryHabits?.vegetarian) dietaryList.push('Vegetarian');
  if (dietaryHabits?.nonVegetarian) dietaryList.push('Non-Vegetarian');
  if (dietaryHabits?.eggitarian) dietaryList.push('Eggitarian');

  const freeFromList = [];
  if (freeFrom?.sugar) freeFromList.push('Sugar-free');
  if (freeFrom?.salt) freeFromList.push('Low-salt/Salt-free');
  if (freeFrom?.processedFood) freeFromList.push('No processed ingredients');
  if (freeFrom?.oil) freeFromList.push('Oil-free');

  const systemPrompt = `You are an expert international dietician and chef AI with expertise in global cuisines including Indian, American, British, Mediterranean, Italian, Mexican, Japanese, Chinese, Thai, Korean, French, and Middle Eastern cuisines.

Generate detailed, healthy recipes with accurate nutritional information tailored to the recipe name and context.

RESPONSE FORMAT - Return ONLY valid JSON matching this exact schema:
{
  "name": "string - recipe name",
  "description": "string - brief 1-2 sentence description of the dish",
  "category": "Indian" | "American" | "British" | "Mediterranean" | "Asian" | "Mexican" | "Italian" | "French" | "Middle Eastern" | "Japanese" | "Chinese" | "Thai" | "Korean" | "Continental" | "Fusion" | "Healthy Bowls" | "Smoothies & Drinks" | "Supplements" | "Keto" | "Vegan Specials" | "High Protein" | "Low Carb" | "Detox" | "Other",
  "cuisine": "string - specific cuisine type (e.g., South Indian, Tex-Mex, Cantonese, Tuscan)",
  "preparationTime": number (minutes),
  "cookingTime": number (minutes),
  "ingredients": [
    {
      "name": "string - ingredient name",
      "quantity": number,
      "unit": "g" | "ml" | "cup" | "tbsp" | "tsp" | "piece",
      "category": "Protein Rich" | "Carbohydrate" | "Vegetable" | "Dairy" | "Spice" | "Oil/Fat" | "Sweetener" | "Grain" | "Legume" | "Nut/Seed" | "Fruit" | "Herb" | "Sauce/Condiment" | "Other",
      "priceLevel": "₹" | "₹₹" | "₹₹₹",
      "description": "string - brief nutritional benefit or cooking note",
      "isScalable": boolean
    }
  ],
  "servingSize": {
    "quantity": number,
    "unit": "g" | "ml",
    "servings": number
  },
  "nutrition": {
    "calories": number (per serving),
    "protein": number (grams per serving),
    "carbs": number (grams per serving),
    "fats": number (grams per serving),
    "fiber": number (grams per serving)
  },
  "cookingSteps": ["string - detailed step 1", "string - detailed step 2", ...],
  "warnings": ["string - any dietary warnings or allergen info"]
}

IMPORTANT RULES:
- Detect the cuisine from recipe name (e.g., "Chicken Tikka" = Indian, "Caesar Salad" = American, "Fish and Chips" = British, "Pad Thai" = Thai)
- All nutritional values should be realistic and accurate
- Include 5-15 ingredients typically
- Include 4-10 cooking steps with clear instructions
- Price levels: ₹ = budget, ₹₹ = moderate, ₹₹₹ = premium
- Categorize each ingredient properly for easy filtering
- Add meaningful descriptions for each ingredient
- Respect all dietary restrictions strictly
- For smoothies/drinks, keep cooking steps simple (blend, mix, serve)
- GROCERY SHOPPING RULE: Always name each ingredient as the RAW item a person would buy at a grocery store, not the processed or prepared form. Examples: write "Lemon" not "Lemon Juice", "Tomato" not "Tomato Puree", "Ginger" not "Ginger Paste", "Garlic" not "Garlic Paste", "Orange" not "Orange Juice". Adjust quantity and unit accordingly (e.g., Lemon 1 piece instead of Lemon Juice 2 tbsp). Only use processed/packaged forms when there is truly no whole raw equivalent (e.g., "Olive Oil", "Soy Sauce", "Coconut Milk" are fine as-is).

QUANTITY OVERRIDE RULE (highest priority - overrides "Include 5-15 ingredients" and all nutritional-balance guidance below): If the dietician's Custom Ingredients/Preferences or Custom Notes text states an explicit quantity and/or unit for a specific ingredient (e.g., "½ cup chickpeas", "1 cup quinoa", "1½ tbs mustard"), treat that stated amount as the PER-SERVING quantity for that ingredient - do not convert cup/tbsp/tsp to grams, do not round to a "typical" serving size, do not substitute a different amount for nutritional-balance reasons. Represent fractional amounts as decimals (½ → 0.5, 1½ → 1.5). Only ingredients NOT given an explicit quantity in the note should have their per-serving quantity determined by you, using the PORTION CALIBRATION below. If the note uses an informal measure with no schema-compatible unit (e.g., "handful of kale", "salt" with no amount), choose the closest reasonable quantity/unit yourself - this rule only binds you when the dietician gave an explicit numeric quantity+unit.

NO ZERO/PLACEHOLDER QUANTITIES RULE: every ingredient's "quantity" MUST be a realistic positive number - NEVER 0, and never a placeholder. This applies even when an ingredient is mentioned with no amount at all (e.g. a note listing "Salt, turmeric, chilli" with nothing after them, or a bare ingredient name with no measure). In that case, infer a standard realistic quantity for that ingredient in this dish's context rather than writing 0 - for example: a pinch of salt ≈ 1g, turmeric ≈ ¼ tsp, a green chilli ≈ 1 piece, an unspecified onion in a chilla/sabzi ≈ 2 tbsp chopped. Every ingredient must be usable in a real shopping list and calorie calculation - a 0-quantity ingredient is never acceptable output.

NUTRITION ACCURACY RULE (highest priority for the "nutrition" object - overrides the calorie band below whenever they conflict): the "nutrition" object (calories, protein, carbs, fats, fiber) MUST be the true nutritional total of the exact ingredients and quantities YOU listed - as if you actually summed each ingredient's real-world nutrition facts for the quantity given. Never report a calorie/macro figure just because it falls inside the target band below if it doesn't match what your own ingredient list actually contains - e.g. a salad whose only fat source is 1 tbsp of oil (~14g fat) must not report fats:36g, and a dish with no oil/ghee/nuts/dairy must not report a high fat number. calories must be internally consistent with protein/carbs/fats via calories ≈ protein×4 + carbs×4 + fats×9. Use the calorie band only to guide how you SIZE the ingredients (rule 2 below) - never as a number to write into "nutrition" independent of the ingredients.

PORTION CALIBRATION (engineering default - a realistic, natural single-serving
size for this dish and meal type, NOT tailored to any specific patient's
calorie needs - this recipe is a reusable catalog item; per-patient calorie
targeting happens later by adjusting the Servings count, not by resizing a
single serving):
Target calorie band for this ${servingTime} recipe, per serving: ${calorieBand[0]}-${calorieBand[1]} kcal.

Apply these rules in order:
1. The calorie band above is a single-person, single-portion target for this Serving Time (e.g. one paratha, one bowl) - a natural, standard-sized portion of this dish, not a clinical prescription.
2. Size ingredient quantities (for ingredients not covered by the QUANTITY OVERRIDE RULE) so ONE serving's total real nutrition falls within that band - then report the "nutrition" object as the actual computed total of those quantities (see NUTRITION ACCURACY RULE above), not the band figure itself.
3. IMPORTANT: Every "quantity" you write for every ingredient, and every "servingSize"/"nutrition" value, must describe EXACTLY ONE SERVING - always, regardless of the Servings number given below. Do NOT multiply, scale, or otherwise adjust anything for the Servings count; ignore Servings entirely when writing quantities. Scaling the recipe up for multiple servings is handled separately by the system after your response, not by you.
- NO markdown, NO explanations, ONLY the JSON object`;

  let userPrompt;
  if (isUpdateMode) {
    // In update mode: AI refines mutable fields only
    userPrompt = `Mode: UPDATE/REFINE existing recipe

Recipe Name: ${name}
Serving Time: ${servingTime}
Servings: ${servings}
TARGET CALORIE BAND FOR THIS RECIPE (per serving): ${calorieBand[0]}-${calorieBand[1]} kcal. Use this to guide how much of each ingredient you include (a natural, standard-sized portion for this Serving Time) - do not default to a "typical" ${servingTime} calorie count you've seen before if it conflicts with this range. However, the NUTRITION ACCURACY RULE above takes priority: nutrition.calories must be the true total of the ingredients/quantities you actually listed, even if that total lands slightly outside this band - never write a calorie figure that doesn't match your own ingredient list just to stay inside the range.
Dietary Restrictions: ${dietaryList.length > 0 ? dietaryList.join(', ') : 'None specified'}
Free From: ${freeFromList.length > 0 ? freeFromList.join(', ') : 'None specified'}
${aiNote ? `Custom Notes: ${aiNote}` : ''}

EXISTING DATA (for reference only):
Ingredients: ${JSON.stringify(existingIngredients, null, 2)}
Cooking Steps: ${JSON.stringify(existingInstructions, null, 2)}
Nutrition: ${JSON.stringify(existingNutrition, null, 2)}

TASK: The dietician has updated the dietary preferences/restrictions for this recipe. You MUST:
1. STRICTLY follow the new Dietary Restrictions and Free From constraints listed above.
2. REMOVE or REPLACE any ingredient that violates the new dietary restrictions (e.g., if Vegan is selected, remove ALL dairy like paneer, cheese, milk, ghee, butter, yogurt, cream and replace with vegan alternatives like tofu, cashew cream, coconut milk, etc.)
3. If Jain is selected, remove onion, garlic, and root vegetables.
4. Re-generate the full ingredients list respecting all constraints, with categories, price levels, and descriptions, sized so total calories fall within the TARGET CALORIES range above.
5. Re-generate cooking steps to match the updated ingredients.
6. Recalculate nutrition values based on the new ingredients - calories MUST be within the TARGET CALORIES range above.
7. Add warnings for any relevant dietary info.

The recipe name, serving time, and servings count stay unchanged. Generate a COMPLETE new recipe that fully respects all dietary constraints and the calorie target.`;
  } else {
    // In generate mode: AI creates a full recipe from scratch
    userPrompt = `Mode: GENERATE new recipe

Recipe Name: ${name}
Serving Time: ${servingTime}
Servings: ${servings}
TARGET CALORIE BAND FOR THIS RECIPE (per serving): ${calorieBand[0]}-${calorieBand[1]} kcal. Use this to guide how much of each ingredient you include (a natural, standard-sized portion for this Serving Time) - do not default to a "typical" ${servingTime} calorie count you've seen before if it conflicts with this range. However, the NUTRITION ACCURACY RULE above takes priority: nutrition.calories must be the true total of the ingredients/quantities you actually listed, even if that total lands slightly outside this band - never write a calorie figure that doesn't match your own ingredient list just to stay inside the range.
Dietary Restrictions: ${dietaryList.length > 0 ? dietaryList.join(', ') : 'None specified'}
Free From: ${freeFromList.length > 0 ? freeFromList.join(', ') : 'None specified'}
${aiNote ? `Custom Ingredients/Preferences: ${aiNote}` : ''}

TASK: Generate a complete, healthy ${name} recipe suitable for ${servingTime}.
- Detect the appropriate cuisine from the recipe name
- Make it authentic and delicious to that cuisine
- Size ingredient quantities so nutrition.calories lands within the TARGET CALORIES range above - this takes priority over any generic notion of a "normal" portion for this dish
- Follow all dietary restrictions strictly
- Provide accurate calorie and macro counts that MUST be within the TARGET CALORIES range above
- Use ingredients commonly available globally
- Name every ingredient as the RAW GROCERY ITEM you would buy at a store (e.g., "Lemon" not "Lemon Juice", "Tomato" not "Tomato Paste")`;
  }

  let parsedRecipe;
  let lastError;
  let refused = false;

  // Computed once and reused across retries/fallback so identical requests
  // stay reproducible - a fresh seed per attempt would reintroduce the exact
  // nondeterminism this is fixing. Passed only to the chat.completions
  // fallback (see computeRecipeSeed comment above for why).
  const seed = computeRecipeSeed({
    name, servingTime, servings, dietaryHabits, freeFrom, aiNote,
    mode: isUpdateMode ? 'update' : 'generate',
  });

  // Shared schema payload - `type: 'json_schema'` lives at a different nesting
  // level between the two APIs, so each call site wraps this differently
  // (see below) rather than reusing one literal object shape for both.
  const jsonSchemaConfig = {
    name: 'recipe_generation',
    schema: RECIPE_JSON_SCHEMA,
    strict: true,
  };

  // With strict Structured Outputs enforcing shape at the API level, the
  // original reason for many retries (malformed/off-schema JSON) mostly goes
  // away - 2 attempts remain only to absorb transient network/rate-limit errors.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await openai.responses.create({
        model: config.openai.recipeModel,
        input: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0,
        text: { format: { type: 'json_schema', ...jsonSchemaConfig } },
      });

      const part = response?.output?.[0]?.content?.[0];
      if (part?.type === 'refusal') {
        console.error(`generateRecipeWithAI responses.create attempt ${attempt} refused:`, part.refusal);
        lastError = new Error(`Model refused: ${part.refusal}`);
        refused = true;
        break; // a deterministic refusal will likely repeat - don't retry, fall through to fallback
      }
      const raw = typeof part === 'string' ? part : part?.text || response?.output_text || '';
      parsedRecipe = parseJsonFromModelOutput(raw);
      break;
    } catch (error) {
      lastError = error;
      console.error(`generateRecipeWithAI responses.create attempt ${attempt} failed:`, error.message);
    }
  }

  // Fallback path: chat completions, same schema + seed for consistency.
  if (!parsedRecipe) {
    try {
      const fallback = await openai.chat.completions.create({
        model: config.openai.recipeModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0,
        seed,
        response_format: { type: 'json_schema', json_schema: jsonSchemaConfig },
      });

      const message = fallback?.choices?.[0]?.message;
      if (message?.refusal) {
        console.error('generateRecipeWithAI chat fallback refused:', message.refusal);
        lastError = new Error(`Model refused: ${message.refusal}`);
      } else {
        parsedRecipe = parseJsonFromModelOutput(message?.content || '');
      }
    } catch (fallbackError) {
      lastError = fallbackError;
      console.error('generateRecipeWithAI chat fallback failed:', fallbackError.message);
    }
  }

  if (refused && !parsedRecipe) {
    throw new Error(`AI declined to generate this recipe: ${lastError?.message || 'policy refusal'}`);
  }

  if (!parsedRecipe) {
    throw new Error(`AI generation failed: ${lastError?.message || 'Unknown error'}`);
  }

  // Ensure all required fields exist with defaults
  // Parse quantity safely — AI may return strings like "100", "1/2", "1.5"
  const parseQuantity = (val) => {
    if (typeof val === 'number' && !Number.isNaN(val)) return val;
    if (typeof val === 'string') {
      // Handle fractions like "1/2"
      if (val.includes('/')) {
        const parts = val.split('/');
        const num = parseFloat(parts[0]);
        const den = parseFloat(parts[1]);
        if (!Number.isNaN(num) && !Number.isNaN(den) && den !== 0) return num / den;
      }
      const parsed = parseFloat(val);
      if (!Number.isNaN(parsed)) return parsed;
    }
    return 0;
  };

  // The model always generates quantities for exactly ONE serving (see the
  // PORTION CALIBRATION rule in systemPrompt) - scaling to the requested
  // Servings count happens here, deterministically, rather than trusting the
  // model to multiply correctly. Verified via live testing that LLM-performed
  // servings arithmetic is unreliable (some ingredients didn't scale at all,
  // others scaled inconsistently, extra ingredients appeared unprompted).
  // Ingredients with isScalable === false (e.g. a fixed pinch of a spice)
  // are intentionally left unscaled.
  const perServingIngredients = Array.isArray(parsedRecipe.ingredients)
    ? parsedRecipe.ingredients.map((ing) => ({
      name: ing.name || 'Unknown Ingredient',
      quantity: parseQuantity(ing.quantity),
      unit: ing.unit || 'g',
      category: ing.category || 'Other',
      priceLevel: ing.priceLevel || '₹₹',
      description: ing.description || '',
      isScalable: ing.isScalable !== false,
    }))
    : [];
  const scaledIngredients = perServingIngredients.map((ing) => (
    ing.isScalable ? { ...ing, quantity: ing.quantity * servings } : ing
  ));

  const perServingSize = parsedRecipe.servingSize || { quantity: 200, unit: 'g' };

  return {
    name: parsedRecipe.name || name,
    description: parsedRecipe.description || '',
    category: parsedRecipe.category || 'Indian',
    cuisine: parsedRecipe.cuisine || 'Indian',
    preparationTime: parsedRecipe.preparationTime || 15,
    cookingTime: parsedRecipe.cookingTime || 20,
    ingredients: scaledIngredients,
    servingSize: {
      quantity: (parseQuantity(perServingSize.quantity) || 200) * servings,
      unit: perServingSize.unit || 'g',
      servings,
    },
    nutrition: {
      calories: parsedRecipe.nutrition?.calories || 0,
      protein: parsedRecipe.nutrition?.protein || 0,
      carbs: parsedRecipe.nutrition?.carbs || 0,
      fats: parsedRecipe.nutrition?.fats || 0,
      fiber: parsedRecipe.nutrition?.fiber || 0,
    },
    cookingSteps: Array.isArray(parsedRecipe.cookingSteps) ? parsedRecipe.cookingSteps : [],
    warnings: Array.isArray(parsedRecipe.warnings) ? parsedRecipe.warnings : [],
    translations: await generateTranslations(parsedRecipe, translationLanguages),
  };
};

/**
 * Generate translations for recipe content in requested languages.
 * Returns an object keyed by language name with translated fields.
 */
const generateTranslations = async (recipe, languages) => {
  if (!languages || languages.length === 0) return {};

  const translations = {};

  for (const lang of languages) {
    try {
      const translationPrompt = `Translate the following recipe content to ${lang}. Return ONLY valid JSON.

Recipe Name: ${recipe.name || ''}
Description: ${recipe.description || ''}
Ingredients: ${JSON.stringify((recipe.ingredients || []).map((i) => ({ name: i.name, description: i.description })))}
Cooking Steps: ${JSON.stringify(recipe.cookingSteps || [])}
Warnings: ${JSON.stringify(recipe.warnings || [])}

Return this exact JSON structure:
{
  "name": "translated recipe name in ${lang}",
  "description": "translated description in ${lang}",
  "ingredients": [{"name": "translated name", "description": "translated description"}],
  "cookingSteps": ["translated step 1", "translated step 2", ...],
  "warnings": ["translated warning 1", ...]
}

IMPORTANT: Translate naturally into ${lang} script. Keep quantities and units in English numerals. NO markdown, ONLY JSON.`;

      const response = await openai.responses.create({
        model: config.openai.translationModel,
        input: [
          { role: 'user', content: translationPrompt },
        ],
        temperature: 0.3,
        text: {},
      });

      const part = response?.output?.[0]?.content?.[0];
      const raw = typeof part === 'string' ? part : part?.text || response?.output_text || '';
      const parsed = parseJsonFromModelOutput(raw);

      if (parsed) {
        translations[lang] = {
          name: parsed.name || recipe.name,
          description: parsed.description || recipe.description || '',
          ingredients: Array.isArray(parsed.ingredients) ? parsed.ingredients : [],
          cookingSteps: Array.isArray(parsed.cookingSteps) ? parsed.cookingSteps : [],
          warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
        };
      }
    } catch (err) {
      console.error(`Translation to ${lang} failed:`, err.message);
      // Skip this language if translation fails
    }
  }

  return translations;
};

/**
 * "Retrieval" stage for scripts/import-recipes-from-diet-plans.js: given the
 * raw text of one source diet-plan document, identifies every distinct dish
 * and returns exactly the source text belonging to each one, so the next
 * stage (generateRecipeWithAI, fed via aiNote) is grounded in the right
 * chunk per dish rather than the whole document. Not part of any HTTP route -
 * called directly from the import script, matching
 * scripts/verify-recipe-determinism.js's precedent for calling these
 * functions directly.
 */
const extractDishesFromDocument = async ({ documentText, sourceFileName }) => {
  const systemPrompt =
    'You are extracting structured dish data from Indian diet-plan documents (English/Marathi/Hindi mix) for a recipe database. Be exhaustive about real, distinct dishes, but disciplined about what counts as one - a recipe database entry needs its own identity and preparation, not a bare pantry staple.';

  const userPrompt = `Source document: ${sourceFileName}

--- DOCUMENT TEXT START ---
${documentText}
--- DOCUMENT TEXT END ---

TASK: Identify every distinct DISH in this document that belongs in a recipe database. A meal combo like "Chilla + Dal + Salad" is up to 3 separate dishes - the chilla, the dal, the salad - but only include a component as its own dish if it has a real identity/preparation of its own.

DO NOT extract as a standalone dish:
- A single raw/unprepared ingredient with no recipe of its own: plain "Rice", plain "Ghee", plain "Salad" (with no dressing/method given), plain "Chapati"/"Roti"/"Bhakri" (with no filling/variant), plain "Egg Whites", plain "Coconut Water", a single fruit like plain "Apple", a bare "Dal"/"Bhaji"/"Sabji" with no specific name or ingredients (e.g. "Protein Bhaji" with no ingredient list is too generic - skip it, but "Paneer Bhurji" with ingredients is a real dish - keep it).
- A quantity/measurement line by itself (e.g. "150g", "1 cup").
These are meal-plan filler items, not recipes - only extract them if the document gives them their own name AND either an ingredient list or a distinct preparation method (e.g. "Roasted Makhana" with a roasting method is fine; "Rice" alone is not; "Besan Chilla" with ingredients is fine; a bare "Salad" with no dressing/ingredients is not).

DO extract as a standalone dish:
- Anything with a distinguishable name and either an ingredient list or cooking steps (e.g. "Doodhi Chilla", "Matki Usal", "Egg Curry", "Jeera Tea", "Banana Oats Pancakes").
- Named dishes mentioned only by name in a weekly schedule table with no detail (e.g. "Palak paratha (3, with ghee)") - these ARE real dishes, just mark hasStructuredIngredients=false for them.

For each dish you do extract:
- dishName MUST be in English. If the source names it in Marathi/Hindi/Devanagari script, translate or transliterate it into an English recipe name (e.g. "अळशी पाणी" -> "Flaxseed Water", "पालक चिल्ला" -> "Palak Chilla", "चिकन करी" -> "Chicken Curry"). Never leave dishName in Devanagari script.
- Map it to exactly one of the 7 servingTime slots based on which meal section it appeared under (Morning Drink, Breakfast, Brunch, Lunch, Evening Snack, Dinner, Night Drink) - use your judgment for ambiguous placements (e.g. "Dry Fruits" before breakfast -> Morning Drink).
- Set hasStructuredIngredients=true only if the document gives a real ingredient list (names, and at least some quantities) for that specific dish. If the dish is only named (e.g. in a weekly schedule table cell) with no ingredient breakdown, set it false and leave rawIngredientsText/rawRecipeText null.
- When hasStructuredIngredients is true, copy rawIngredientsText and rawRecipeText VERBATIM from the source (preserve original language/wording/quantities exactly, even if in Marathi) - do not translate the raw text itself, only dishName. Translation of the full recipe happens in a later stage.
- Do not invent dishes that aren't in the text.`;

  const jsonSchemaConfig = {
    name: 'dish_extraction',
    schema: DISH_EXTRACTION_JSON_SCHEMA,
    strict: true,
  };

  let parsed;
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await openai.responses.create({
        model: config.openai.dietPlanModel,
        input: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.2,
        text: { format: { type: 'json_schema', ...jsonSchemaConfig } },
      });

      const part = response?.output?.[0]?.content?.[0];
      if (part?.type === 'refusal') {
        lastError = new Error(`Model refused: ${part.refusal}`);
        break;
      }
      const raw = typeof part === 'string' ? part : part?.text || response?.output_text || '';
      parsed = parseJsonFromModelOutput(raw);
      break;
    } catch (error) {
      lastError = error;
      console.error(`extractDishesFromDocument attempt ${attempt} failed:`, error.message);
    }
  }

  if (!parsed) {
    if (!parsed) {
      try {
        const fallback = await openai.chat.completions.create({
          model: config.openai.dietPlanModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.2,
          response_format: { type: 'json_schema', json_schema: jsonSchemaConfig },
        });
        const message = fallback?.choices?.[0]?.message;
        if (!message?.refusal) {
          parsed = parseJsonFromModelOutput(message?.content || '');
        }
      } catch (fallbackError) {
        lastError = fallbackError;
        console.error('extractDishesFromDocument chat fallback failed:', fallbackError.message);
      }
    }
  }

  if (!parsed) {
    throw new Error(`Dish extraction failed for ${sourceFileName}: ${lastError?.message || 'Unknown error'}`);
  }

  return Array.isArray(parsed.dishes) ? parsed.dishes : [];
};

module.exports = {
  generateDietPlanWithAI,
  generateRecipeWithAI,
  extractDishesFromDocument,
  generateTranslations,
};
