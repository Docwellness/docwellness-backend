const OpenAI = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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

  return sections
    .map(({ title, data }) => {
      if (!data) return `${title}: Not provided.`;
      return `${title}: ${JSON.stringify(data)}`;
    })
    .join('\n');
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

const buildPrompt = ({
  patient,
  firstConsultation,
  calorieStrategy,
  macroStrategy,
  recipes = [],
}) => {
  const bio = extractPatientBio(patient);
  const consultationSummary = summarizeConsultation(firstConsultation);
  const strategySummary = summarizeStrategy(calorieStrategy, macroStrategy);
  const recipesJson = JSON.stringify(recipes);

  return `You are an expert Indian dietician. Generate a personalized 4-week diet plan. Each day has 7 meals (Morning Drink, Breakfast, Brunch, Lunch, Evening Snack, Dinner, Night Drink). Use ONLY the recipes provided below.

Patient Details:
${bio}

Consultation Summary:
${consultationSummary}

Strategy:
${strategySummary}

Available recipes (JSON array):
${recipesJson}

Rules:
- You MUST choose meals only from this recipes array.
- For every meal, you MUST use a valid recipe "id" from the list.
- Match servingTime: Breakfast recipes only for Breakfast, Dinner recipes only for Dinner, etc.
- Create exactly 4 weekly meal sets: Week 1, Week 2, Week 3, Week 4.
- Within the same week, the meals are THE SAME for all 7 days.
- Across different weeks, try to provide variety while staying close to the target calorieBudget.
- Distribute calories realistically across meals: lighter for Morning Drink and Night Drink, higher for Lunch and Dinner.
- Respect dietaryHabits and freeFrom flags according to the patient's profile and consultation notes.

Output Requirements:
- Respond ONLY with JSON in this exact structure (no comments, no extra text):
{
  "weeks": [
    {
      "week": 1,
      "dailyMeals": [
        { "servingTime": "Morning Drink", "recipeId": "<id from recipes>" },
        { "servingTime": "Breakfast", "recipeId": "<id from recipes>" },
        { "servingTime": "Brunch", "recipeId": "<id from recipes>" },
        { "servingTime": "Lunch", "recipeId": "<id from recipes>" },
        { "servingTime": "Evening Snack", "recipeId": "<id from recipes>" },
        { "servingTime": "Dinner", "recipeId": "<id from recipes>" },
        { "servingTime": "Night Drink", "recipeId": "<id from recipes>" }
      ]
    },
    {
      "week": 2,
      "dailyMeals": [ /* same 7 servingTime entries with different recipeId choices */ ]
    },
    {
      "week": 3,
      "dailyMeals": [ /* same structure */ ]
    },
    {
      "week": 4,
      "dailyMeals": [ /* same structure */ ]
    }
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
}) => {
  try {
    const prompt = buildPrompt({
      patient,
      firstConsultation,
      calorieStrategy,
      macroStrategy,
      recipes,
    });

    console.log('=== Calling OpenAI API ===');
    console.log('Recipes count:', recipes.length);
    console.log('Patient:', patient?.profile?.fullName);

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content:
            'You are an expert Indian dietician. Generate personalized diet plans in JSON format only.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.4,
      response_format: { type: 'json_object' },
    });

    const content = response?.choices?.[0]?.message?.content;
    console.log('=== OpenAI Response received ===');
    console.log('Response length:', content?.length || 0);

    if (!content) {
      console.error('OpenAI returned empty content');
      return JSON.stringify({ weeks: [] });
    }

    return content;
  } catch (error) {
    console.error('Error generating diet plan via OpenAI:', error.message);
    console.error('Full error:', error);
    throw error;
  }
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
      "priceLevel": "$" | "$$" | "$$$",
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
- Price levels: $ = budget, $$ = moderate, $$$ = premium
- Categorize each ingredient properly for easy filtering
- Add meaningful descriptions for each ingredient
- Respect all dietary restrictions strictly
- For smoothies/drinks, keep cooking steps simple (blend, mix, serve)
- GROCERY SHOPPING RULE: Always name each ingredient as the RAW item a person would buy at a grocery store, not the processed or prepared form. Examples: write "Lemon" not "Lemon Juice", "Tomato" not "Tomato Puree", "Ginger" not "Ginger Paste", "Garlic" not "Garlic Paste", "Orange" not "Orange Juice". Adjust quantity and unit accordingly (e.g., Lemon 1 piece instead of Lemon Juice 2 tbsp). Only use processed/packaged forms when there is truly no whole raw equivalent (e.g., "Olive Oil", "Soy Sauce", "Coconut Milk" are fine as-is).
- NO markdown, NO explanations, ONLY the JSON object`;

  let userPrompt;
  if (isUpdateMode) {
    // In update mode: AI refines mutable fields only
    userPrompt = `Mode: UPDATE/REFINE existing recipe

Recipe Name: ${name}
Serving Time: ${servingTime}
Servings: ${servings}
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
4. Re-generate the full ingredients list respecting all constraints, with categories, price levels, and descriptions.
5. Re-generate cooking steps to match the updated ingredients.
6. Recalculate nutrition values based on the new ingredients.
7. Add warnings for any relevant dietary info.

The recipe name, serving time, and servings count stay unchanged. Generate a COMPLETE new recipe that fully respects all dietary constraints.`;
  } else {
    // In generate mode: AI creates a full recipe from scratch
    userPrompt = `Mode: GENERATE new recipe

Recipe Name: ${name}
Serving Time: ${servingTime}
Servings: ${servings}
Dietary Restrictions: ${dietaryList.length > 0 ? dietaryList.join(', ') : 'None specified'}
Free From: ${freeFromList.length > 0 ? freeFromList.join(', ') : 'None specified'}
${aiNote ? `Custom Ingredients/Preferences: ${aiNote}` : ''}

TASK: Generate a complete, healthy ${name} recipe suitable for ${servingTime}.
- Detect the appropriate cuisine from the recipe name
- Make it authentic and delicious to that cuisine
- Ensure nutritional balance
- Follow all dietary restrictions strictly
- Provide accurate calorie and macro counts
- Use ingredients commonly available globally
- Name every ingredient as the RAW GROCERY ITEM you would buy at a store (e.g., "Lemon" not "Lemon Juice", "Tomato" not "Tomato Paste")`;
  }

  let parsedRecipe;
  let lastError;

  // Retry a few times because model output can intermittently be malformed.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await openai.responses.create({
        model: 'gpt-4o',
        input: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.5,
        text: {},
      });

      const part = response?.output?.[0]?.content?.[0];
      const raw = typeof part === 'string' ? part : part?.text || response?.output_text || '';
      parsedRecipe = parseJsonFromModelOutput(raw);
      break;
    } catch (error) {
      lastError = error;
      console.error(`generateRecipeWithAI responses.create attempt ${attempt} failed:`, error.message);
    }
  }

  // Fallback path: use chat completions with strict JSON mode.
  if (!parsedRecipe) {
    try {
      const fallback = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.4,
        response_format: { type: 'json_object' },
      });

      const fallbackText = fallback?.choices?.[0]?.message?.content || '';
      parsedRecipe = parseJsonFromModelOutput(fallbackText);
    } catch (fallbackError) {
      lastError = fallbackError;
      console.error('generateRecipeWithAI chat fallback failed:', fallbackError.message);
    }
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

  return {
    name: parsedRecipe.name || name,
    description: parsedRecipe.description || '',
    category: parsedRecipe.category || 'Indian',
    cuisine: parsedRecipe.cuisine || 'Indian',
    preparationTime: parsedRecipe.preparationTime || 15,
    cookingTime: parsedRecipe.cookingTime || 20,
    ingredients: Array.isArray(parsedRecipe.ingredients)
      ? parsedRecipe.ingredients.map((ing) => ({
        name: ing.name || 'Unknown Ingredient',
        quantity: parseQuantity(ing.quantity),
        unit: ing.unit || 'g',
        category: ing.category || 'Other',
        priceLevel: ing.priceLevel || '₹₹',
        description: ing.description || '',
        isScalable: ing.isScalable !== false,
      }))
      : [],
    servingSize: parsedRecipe.servingSize || {
      quantity: 200,
      unit: 'g',
      servings: servings,
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
        model: 'gpt-4o-mini',
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

module.exports = {
  generateDietPlanWithAI,
  generateRecipeWithAI,
};
