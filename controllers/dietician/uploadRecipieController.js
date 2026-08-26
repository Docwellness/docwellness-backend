const crypto = require('crypto');
const Recipe = require('../../models/Recipe');
const GenerationLog = require('../../models/GenerationLog');
const config = require('../../config/environment');
const { generateRecipeWithAI } = require('../../utils/openaiClient');
const {
  validateRecipeConstraints,
  validateGeneratedIngredients,
} = require('../../utils/dietaryConstraintValidator');
const {
  applyAiNoteQuantityOverrides,
  enforceFiniteIngredientQuantities,
} = require('../../utils/ingredientQuantityValidator');
const { checkTextSafety } = require('../../utils/inputGuardrails');
const { checkNutritionPlausibility } = require('../../utils/recipeNutritionValidator');
const { TOP_CATEGORIES, resolveTopCategoryFilter } = require('../../utils/recipeCategoryGroups');
const { SIDE_SALAD_ELIGIBLE_SLOTS } = require('../../utils/dietPlanOptions');
const cloudinary = require('../../config/cloudinary');
const { cloudinaryUserFolder } = require('../../utils/cloudinaryFolder');
const { getOrCreateIngredientImage } = require('../../utils/ingredientLibrary');
const { COMPONENT_UNITS } = require('../../utils/recipeJsonSchema');
const fs = require('fs');

const hashRecipeInput = ({ name, servingTime, servings, dietaryHabits, freeFrom, aiNote }) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify({ name, servingTime, servings, dietaryHabits, freeFrom, aiNote: aiNote || '' }))
    .digest('hex');

const logRecipeGeneration = async ({ dieticianId, inputHash, latencyMs, warnings, succeeded }) => {
  try {
    await GenerationLog.create({
      kind: 'recipe',
      dieticianId,
      model: config.openai.recipeModel,
      inputHash,
      latencyMs,
      validatorWarnings: warnings || [],
      succeeded,
    });
  } catch (logError) {
    console.error('Failed to write GenerationLog entry:', logError.message);
  }
};

exports.uploadRecipeImage = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Image file is required',
      });
    }

    const uploadResult = await cloudinary.uploader.upload(req.file.path, {
      folder: cloudinaryUserFolder(req.user._id, 'recipes/main'),
    });
    await fs.promises.unlink(req.file.path).catch(() => { });
    const imageUrl = uploadResult?.secure_url || uploadResult?.url;

    return res.status(200).json({
      success: true,
      data: {
        url: imageUrl,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.uploadIngredientImage = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Image file is required',
      });
    }

    const uploadResult = await cloudinary.uploader.upload(req.file.path, {
      folder: cloudinaryUserFolder(req.user._id, 'recipes/ingredients'),
    });
    await fs.promises.unlink(req.file.path).catch(() => { });
    const imageUrl = uploadResult?.secure_url || uploadResult?.url;

    return res.status(200).json({
      success: true,
      data: {
        url: imageUrl,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Fetch a real photo of an ingredient from the internet (Pexels)
 *          and mirror it into Cloudinary - replaces the old device-upload
 *          flow for ingredient images. Can be called repeatedly for the
 *          same ingredient ("refresh") to get a different result - always
 *          fetches fresh (forceRefresh) rather than reusing the shared
 *          library, since a refresh click means "I want something different."
 * @route   POST /api/dietician/uploads/ingredient-image/fetch
 * @access  Private (Dietician)
 * @body    { ingredientName }
 */
exports.fetchIngredientImageFromWeb = async (req, res, next) => {
  try {
    const { ingredientName } = req.body || {};
    if (!ingredientName || !ingredientName.trim()) {
      return res.status(400).json({
        success: false,
        message: 'ingredientName is required',
      });
    }

    const { image: imageUrl } = await getOrCreateIngredientImage({
      dieticianId: req.user._id,
      name: ingredientName,
      forceRefresh: true,
    });
    if (!imageUrl) {
      return res.status(502).json({
        success: false,
        message: `Couldn't find an image for "${ingredientName}". Please try again.`,
      });
    }

    return res.status(200).json({
      success: true,
      data: { url: imageUrl },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Persist a single ingredient's image on an already-saved recipe.
 *          Needed because editing an ingredient's image while viewing an
 *          existing recipe previously only updated in-memory preview state
 *          and never actually reached the database.
 * @route   PATCH /api/dietician/recipes/:id/ingredient-image
 * @access  Private (Dietician)
 * @body    { ingredientIndex, imageUrl }
 *
 * Matches by array index rather than ingredient name - a recipe can have
 * two ingredients with the same name (e.g. "Salt" used at two different
 * steps), and Mongo's positional `$` operator only updates the FIRST match,
 * which would silently update the wrong one under name-based matching.
 */
exports.updateIngredientImage = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { ingredientIndex, imageUrl } = req.body || {};
    if (!Number.isInteger(ingredientIndex) || ingredientIndex < 0 || !imageUrl) {
      return res.status(400).json({
        success: false,
        message: 'ingredientIndex (a non-negative integer) and imageUrl are required',
      });
    }

    const result = await Recipe.updateOne(
      { _id: id, dieticianId: req.user._id, [`ingredients.${ingredientIndex}`]: { $exists: true } },
      { $set: { [`ingredients.${ingredientIndex}.image`]: imageUrl } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        message: `Recipe or ingredient at index ${ingredientIndex} not found`,
      });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Generate a recipe preview using AI
 * @route   POST /api/dietician/recipes/ai-generate-preview
 * @access  Private (Dietician)
 *
 * Request body:
 * {
 *   name: string (required) - Recipe name
 *   servingTime: string (required) - When to serve (Morning Drink, Breakfast, etc.)
 *   servings: number (required) - Number of servings
 *   dietaryHabits: { vegan, jain, vegetarian, nonVegetarian, eggitarian } - All boolean
 *   freeFrom: { sugar, salt, processedFood, oil } - All boolean
 *   aiNote: string - Custom ingredients/preferences from user
 * }
 *
 * Response includes enhanced ingredients with:
 *   - category (Protein Rich, Carbohydrate, Vegetable, etc.)
 *   - priceLevel (₹, ₹₹, ₹₹₹)
 *   - description (nutritional benefit or cooking note)
 */
exports.generateRecipeWithAI = async (req, res, next) => {
  try {
    const { name, servingTime, servings, dietaryHabits, freeFrom, aiNote, language } = req.body || {};

    // Validate required fields
    if (!name || !servingTime || !servings) {
      return res.status(400).json({
        success: false,
        message: 'Name, servingTime, and servings are required',
      });
    }

    // Validate servingTime
    const VALID_SERVING_TIMES = [
      'Morning Drink',
      'Breakfast',
      'Brunch',
      'Lunch',
      'Evening Snack',
      'Dinner',
      'Night Drink',
    ];

    if (!VALID_SERVING_TIMES.includes(servingTime)) {
      return res.status(400).json({
        success: false,
        message: `servingTime must be one of: ${VALID_SERVING_TIMES.join(', ')}`,
      });
    }

    // Pre-check: reject contradictory dietary habits or custom ingredients
    // that conflict with the selected restrictions before spending an AI call.
    const constraintCheck = validateRecipeConstraints({ dietaryHabits, freeFrom, aiNote });
    if (!constraintCheck.valid) {
      return res.status(400).json({
        success: false,
        message: 'Dietary constraint conflict',
        errors: constraintCheck.errors,
      });
    }

    // Guardrail: aiNote is free text a dietician can enter, and is
    // interpolated directly into the generation prompt - screen it before
    // spending an AI call (OWASP LLM01 prompt-injection/unsafe-content defense).
    if (aiNote) {
      const safety = await checkTextSafety(aiNote);
      if (!safety.safe) {
        return res.status(422).json({
          success: false,
          message: "This note couldn't be processed — please rephrase it.",
        });
      }
    }

    // Parse languages from comma-separated string
    const languages = language
      ? language.split(',').map((l) => l.trim()).filter(Boolean)
      : ['English'];

    const inputHash = hashRecipeInput({ name, servingTime, servings, dietaryHabits, freeFrom, aiNote });
    const generationStartedAt = Date.now();
    let modelRecipe;
    try {
      modelRecipe = await generateRecipeWithAI({
        name,
        servingTime,
        servings,
        dietaryHabits,
        freeFrom,
        aiNote,
        languages,
      });
    } catch (aiError) {
      console.error('AI error in generateRecipeWithAI:', aiError);
      await logRecipeGeneration({
        dieticianId: req.user._id,
        inputHash,
        latencyMs: Date.now() - generationStartedAt,
        succeeded: false,
      });
      return res.status(502).json({
        success: false,
        message: 'AI service error. Please try again later.',
      });
    }

    // Build preview response with enhanced ingredient format
    const previewRecipe = {
      name: modelRecipe.name || name,
      description: modelRecipe.description || '',
      category: modelRecipe.category || 'Indian',
      cuisine: modelRecipe.cuisine || 'Indian',
      servingTime,
      servings,
      preparationTime: modelRecipe.preparationTime || null,
      cookingTime: modelRecipe.cookingTime || null,
      dietaryHabits: dietaryHabits || {},
      freeFrom: freeFrom || {},
      ingredients: Array.isArray(modelRecipe.ingredients)
        ? modelRecipe.ingredients.map((ing) => ({
          name: ing.name,
          quantity: ing.quantity,
          unit: ing.unit || 'g',
          category: ing.category || 'Other',
          priceLevel: ing.priceLevel || '₹₹',
          description: ing.description || '',
          isScalable: ing.isScalable !== false,
          image: null, // To be added by dietician later
        }))
        : [],
      servingSize: modelRecipe.servingSize || {
        quantity: null,
        unit: null,
        servings,
      },
      ...(modelRecipe.secondaryComponent ? { secondaryComponent: modelRecipe.secondaryComponent } : {}),
      components: Array.isArray(modelRecipe.components) && modelRecipe.components.length > 0
        ? modelRecipe.components
        : [{ label: modelRecipe.name || name, quantity: modelRecipe.servingSize?.quantity || null, unit: modelRecipe.servingSize?.unit || null }],
      nutrition: modelRecipe.nutrition || {
        calories: null,
        protein: null,
        carbs: null,
        fats: null,
        fiber: null,
      },
      cookingSteps: Array.isArray(modelRecipe.cookingSteps) ? modelRecipe.cookingSteps : [],
      warnings: Array.isArray(modelRecipe.warnings) ? modelRecipe.warnings : [],
      language: languages,
      translations: modelRecipe.translations || {},
    };

    // Deterministic backstop: re-derive the dietician's literally-stated
    // quantities from aiNote and overwrite whatever the model returned for
    // those ingredients, so quantity fidelity doesn't depend purely on the
    // model following the prompt's QUANTITY OVERRIDE RULE every time.
    const { ingredients: correctedIngredients, appliedOverrides } = applyAiNoteQuantityOverrides({
      aiNote,
      ingredients: previewRecipe.ingredients,
      servings,
    });
    previewRecipe.ingredients = correctedIngredients;
    if (appliedOverrides.length > 0) {
      console.log('generateRecipeWithAI: aiNote quantity override applied:', appliedOverrides);
    }

    // Final deterministic backstop: any ingredient still left with a
    // non-positive/non-finite quantity (the model ignored both the prompt
    // rule and the schema minimum) gets a small sensible default instead of
    // ever reaching the database as 0/NaN.
    const { ingredients: finiteIngredients, corrections: quantityCorrections } =
      enforceFiniteIngredientQuantities(previewRecipe.ingredients);
    previewRecipe.ingredients = finiteIngredients;
    const quantityWarnings = quantityCorrections.map(
      (c) => `Quantity for "${c.ingredient}" wasn't specified - defaulted to ${c.to.quantity}${c.to.unit}, please verify.`
    );
    if (quantityCorrections.length > 0) {
      console.log('generateRecipeWithAI: zero/invalid quantity corrections applied:', quantityCorrections);
    }

    // Post-check: catch cases where the AI didn't fully honor the dietary
    // restrictions despite the prompt instructions (defense in depth).
    const ingredientWarnings = validateGeneratedIngredients({
      dietaryHabits,
      freeFrom,
      ingredients: previewRecipe.ingredients,
    });

    // Deterministic sanity check: does the claimed calorie total look
    // plausible against a rough, category-based estimate from the
    // ingredients themselves? Catches severe AI undercounts (see
    // recipeNutritionValidator.js) without blocking generation.
    const nutritionWarning = checkNutritionPlausibility({
      ingredients: previewRecipe.ingredients,
      claimedCalories: previewRecipe.nutrition?.calories,
    });

    previewRecipe.warnings = [
      ...quantityWarnings,
      ...ingredientWarnings,
      ...(nutritionWarning ? [nutritionWarning] : []),
      ...previewRecipe.warnings,
    ];

    await logRecipeGeneration({
      dieticianId: req.user._id,
      inputHash,
      latencyMs: Date.now() - generationStartedAt,
      warnings: previewRecipe.warnings,
      succeeded: true,
    });

    return res.status(200).json({
      success: true,
      data: previewRecipe,
    });
  } catch (error) {
    next(error);
  }
};

// Allowed enum values from the Recipe schema - shared by createRecipe and
// updateRecipe, the two handlers that persist a recipe.
const VALID_CATEGORIES = [
  'Indian', 'American', 'British', 'Mediterranean', 'Asian', 'Mexican',
  'Italian', 'French', 'Middle Eastern', 'Japanese', 'Chinese', 'Thai',
  'Korean', 'Continental', 'Fusion', 'Healthy Bowls', 'Smoothies & Drinks',
  'Supplements', 'Keto', 'Vegan Specials', 'High Protein', 'Low Carb',
  'Detox', 'Other', 'Western',
];
const VALID_UNITS = ['g', 'ml', 'cup', 'tbsp', 'tsp', 'piece'];
const VALID_PRICE_LEVELS = ['$', '$$', '$$$', '₹', '₹₹', '₹₹₹', '£', '££', '£££'];
const VALID_INGREDIENT_CATEGORIES = [
  'Protein Rich', 'Carbohydrate', 'Vegetable', 'Dairy', 'Spice', 'Oil/Fat',
  'Sweetener', 'Grain', 'Legume', 'Nut/Seed', 'Fruit', 'Herb',
  'Sauce/Condiment', 'Other',
];

// Parse quantity safely — values may arrive as strings from AI
const parseQuantity = (val) => {
  if (typeof val === 'number' && !Number.isNaN(val)) return val;
  if (typeof val === 'string') {
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

/**
 * Sanitizes a raw ingredients array (enum whitelisting + quantity parsing +
 * the zero/invalid-quantity backstop) so Mongoose validation never rejects
 * the whole recipe doc and a blank/zero quantity never reaches the database
 * untouched. Shared by createRecipe and updateRecipe - the two handlers
 * that actually persist a recipe.
 * Returns { ingredients, warnings }.
 */
function sanitizeRecipeIngredients(ingredients) {
  const rawSafeIngredients = Array.isArray(ingredients)
    ? ingredients.map((ing) => ({
      ...ing,
      quantity: parseQuantity(ing.quantity),
      unit: VALID_UNITS.includes(ing.unit) ? ing.unit : 'g',
      priceLevel: VALID_PRICE_LEVELS.includes(ing.priceLevel) ? ing.priceLevel : '₹₹',
      category: VALID_INGREDIENT_CATEGORIES.includes(ing.category) ? ing.category : 'Other',
    }))
    : [];

  const { ingredients: safeIngredients, corrections: quantityCorrections } =
    enforceFiniteIngredientQuantities(rawSafeIngredients);
  const warnings = quantityCorrections.map(
    (c) => `Quantity for "${c.ingredient}" wasn't specified - defaulted to ${c.to.quantity}${c.to.unit}, please verify.`
  );

  return { ingredients: safeIngredients, warnings };
}

/**
 * Sanitizes a raw `components` array (see models/Recipe.js's `components`
 * field) the same way sanitizeRecipeIngredients does for ingredients - a
 * bad/missing unit falls back to 'g' rather than failing Mongoose
 * validation outright, since this is client-submitted data (createRecipe/
 * updateRecipe accept it directly, unlike the AI-generation path which is
 * already constrained by RECIPE_JSON_SCHEMA). Drops entries with no usable
 * label/quantity instead of writing garbage.
 */
function sanitizeRecipeComponents(components) {
  if (!Array.isArray(components)) return undefined;
  const safe = components
    .map((c) => ({
      label: typeof c?.label === 'string' ? c.label.trim() : '',
      quantity: parseQuantity(c?.quantity),
      unit: COMPONENT_UNITS.includes(c?.unit) ? c.unit : 'g',
    }))
    .filter((c) => c.label && c.quantity > 0);
  return safe.length > 0 ? safe : undefined;
}

/**
 * @desc    Create a new recipe
 * @route   POST /api/dietician/recipes
 * @access  Private (Dietician)
 */
exports.createRecipe = async (req, res, next) => {
  try {
    const {
      name,
      category,
      description,
      servingTime,
      servings,
      dietaryHabits,
      freeFrom,
      servingSize,
      secondaryComponent,
      components,
      ingredients,
      cookingSteps,
      nutrition,
      image,
      language,
      translations,
    } = req.body || {};

    // Validate required fields
    if (!name || !servingTime || !servings) {
      return res.status(400).json({
        success: false,
        message: 'Name, servingTime, and servings are required',
      });
    }

    // Sanitize category to match schema enum
    const safeCategory = VALID_CATEGORIES.includes(category) ? category : 'Indian';

    const { ingredients: safeIngredients, warnings: quantityWarnings } =
      sanitizeRecipeIngredients(ingredients);
    const safeComponents = sanitizeRecipeComponents(components);

    // Parse languages from comma-separated string or array
    let languages;
    if (Array.isArray(language)) {
      languages = language;
    } else if (typeof language === 'string') {
      languages = language.split(',').map((l) => l.trim()).filter(Boolean);
    } else {
      languages = ['English'];
    }

    // Auto-fetch an internet photo for every ingredient that doesn't already
    // have one, so a newly-created recipe never needs a manual refresh click
    // just to look complete. Reuses the dietician's shared ingredient
    // library whenever possible (forceRefresh:false) - after a handful of
    // recipes seed common names like Salt/Onion/Tomato, most ingredients
    // resolve instantly with no Pexels call at all. Best-effort and
    // parallel - a failed fetch for one ingredient leaves its image blank
    // rather than failing the save.
    const ingredientsWithImages = await Promise.all(
      safeIngredients.map(async (ing) => {
        if (ing.image && ing.image.trim()) return ing;
        const { image: fetchedUrl } = await getOrCreateIngredientImage({
          dieticianId: req.user._id,
          name: ing.name,
          category: ing.category,
        });
        return fetchedUrl ? { ...ing, image: fetchedUrl } : ing;
      })
    );

    const recipe = await Recipe.create({
      dieticianId: req.user._id,
      name,
      category: safeCategory,
      description,
      servingTime,
      servings,
      dietaryHabits,
      freeFrom,
      servingSize,
      secondaryComponent,
      components: safeComponents,
      ingredients: ingredientsWithImages,
      instructions: cookingSteps,
      nutrition,
      image,
      language: languages,
      translations: translations || {},
    });

    return res.status(201).json({
      success: true,
      data: recipe,
      warnings: quantityWarnings,
    });
  } catch (error) {
    console.error('❌ createRecipe error:', error.message, error.errors ? JSON.stringify(error.errors) : '');
    next(error);
  }
};

/**
 * @desc    Update AI recipe preview based on dietician edits
 * @route   POST /api/dietician/recipes/ai-update-from-edits
 * @access  Private (Dietician)
 *
 * Immutable fields (always preserved from request):
 *   - name
 *   - servingTime
 *   - servings
 *   - dietaryHabits
 *   - freeFrom
 *   - aiNote
 *
 * Mutable fields (AI-refined with fallbacks):
 *   - ingredients
 *   - nutrition
 *   - cookingSteps (instructions)
 *   - warnings
 */
exports.updateRecipeFromEdits = async (req, res, next) => {
  try {
    const {
      name,
      servingTime,
      servings,
      dietaryHabits,
      freeFrom,
      aiNote,
      ingredients,
      instructions,
      nutrition,
      language,
    } = req.body || {};

    // Validate required immutable fields
    if (!name || !servingTime || !servings) {
      return res.status(400).json({
        success: false,
        message: 'Name, servingTime, and servings are required',
      });
    }

    if (!Array.isArray(ingredients) || ingredients.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Ingredients array is required and must not be empty',
      });
    }

    // Pre-check: reject contradictory dietary habits or custom ingredients
    // that conflict with the selected restrictions before spending an AI call.
    const constraintCheck = validateRecipeConstraints({ dietaryHabits, freeFrom, aiNote });
    if (!constraintCheck.valid) {
      return res.status(400).json({
        success: false,
        message: 'Dietary constraint conflict',
        errors: constraintCheck.errors,
      });
    }

    // Guardrail: aiNote is free text a dietician can enter, and is
    // interpolated directly into the generation prompt - screen it before
    // spending an AI call (OWASP LLM01 prompt-injection/unsafe-content defense).
    if (aiNote) {
      const safety = await checkTextSafety(aiNote);
      if (!safety.safe) {
        return res.status(422).json({
          success: false,
          message: "This note couldn't be processed — please rephrase it.",
        });
      }
    }

    // Parse languages from comma-separated string
    const languages = language
      ? language.split(',').map((l) => l.trim()).filter(Boolean)
      : ['English'];

    let updatedRecipe;
    try {
      updatedRecipe = await generateRecipeWithAI({
        name,
        servingTime,
        servings,
        dietaryHabits,
        freeFrom,
        aiNote,
        existingIngredients: ingredients,
        existingInstructions: instructions,
        existingNutrition: nutrition,
        languages,
      });
    } catch (aiError) {
      console.error('AI error in updateRecipeFromEdits:', aiError);
      return res.status(502).json({
        success: false,
        message: 'AI service error. Please try again later.',
      });
    }

    // Build final response: preserve immutable fields, use AI-refined values for mutable fields with fallbacks
    // Ensure enhanced ingredient format with category, priceLevel, and description
    const enhanceIngredient = (ing) => ({
      name: ing.name,
      quantity: ing.quantity,
      unit: ing.unit || 'g',
      category: ing.category || 'Other',
      priceLevel: ing.priceLevel || '₹₹',
      description: ing.description || '',
      isScalable: ing.isScalable !== false,
      image: ing.image || null,
    });

    const finalIngredients =
      Array.isArray(updatedRecipe.ingredients) && updatedRecipe.ingredients.length > 0
        ? updatedRecipe.ingredients.map(enhanceIngredient)
        : (ingredients || []).map(enhanceIngredient);

    const finalNutrition = updatedRecipe.nutrition ||
      nutrition || {
      calories: null,
      protein: null,
      carbs: null,
      fats: null,
      fiber: null,
    };

    const finalCookingSteps =
      Array.isArray(updatedRecipe.cookingSteps) && updatedRecipe.cookingSteps.length > 0
        ? updatedRecipe.cookingSteps
        : instructions || [];

    // Deterministic backstop: re-derive the dietician's literally-stated
    // quantities from aiNote and overwrite whatever the model returned for
    // those ingredients (see generateRecipeWithAI above for full rationale).
    const { ingredients: correctedIngredients, appliedOverrides } = applyAiNoteQuantityOverrides({
      aiNote,
      ingredients: finalIngredients,
      servings,
    });
    if (appliedOverrides.length > 0) {
      console.log('updateRecipeFromEdits: aiNote quantity override applied:', appliedOverrides);
    }

    // Final deterministic backstop (see generateRecipeWithAI above for full
    // rationale): no ingredient should ever reach the database with a
    // non-positive/non-finite quantity.
    const { ingredients: finiteIngredients, corrections: quantityCorrections } =
      enforceFiniteIngredientQuantities(correctedIngredients);
    const quantityWarnings = quantityCorrections.map(
      (c) => `Quantity for "${c.ingredient}" wasn't specified - defaulted to ${c.to.quantity}${c.to.unit}, please verify.`
    );
    if (quantityCorrections.length > 0) {
      console.log('updateRecipeFromEdits: zero/invalid quantity corrections applied:', quantityCorrections);
    }

    // Post-check: catch cases where the AI didn't fully honor the dietary
    // restrictions despite the prompt instructions (defense in depth).
    const ingredientWarnings = validateGeneratedIngredients({
      dietaryHabits,
      freeFrom,
      ingredients: finiteIngredients,
    });

    // Deterministic sanity check (see generateRecipeWithAI above for full
    // rationale): does the claimed calorie total look plausible against a
    // rough, category-based estimate from the ingredients themselves?
    const nutritionWarning = checkNutritionPlausibility({
      ingredients: finiteIngredients,
      claimedCalories: finalNutrition?.calories,
    });

    const finalWarnings = [
      ...quantityWarnings,
      ...ingredientWarnings,
      ...(nutritionWarning ? [nutritionWarning] : []),
      ...(Array.isArray(updatedRecipe.warnings) ? updatedRecipe.warnings : []),
    ];

    const updatedPreview = {
      // Immutable fields: always from request body (AI cannot change these)
      name,
      servingTime,
      servings,
      dietaryHabits: dietaryHabits || {},
      freeFrom: freeFrom || {},
      description: updatedRecipe.description || '',
      category: updatedRecipe.category || 'Indian',
      cuisine: updatedRecipe.cuisine || 'Indian',
      preparationTime: updatedRecipe.preparationTime || null,
      cookingTime: updatedRecipe.cookingTime || null,

      // Mutable fields: AI-refined with fallbacks to original values
      ingredients: finiteIngredients,
      nutrition: finalNutrition,
      cookingSteps: finalCookingSteps,
      warnings: finalWarnings,
      language: languages,
      translations: updatedRecipe.translations || {},
    };

    return res.status(200).json({
      success: true,
      data: updatedPreview,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    One-off maintenance operation: AI-generates and saves cooking
 *          steps for every one of this dietician's recipes that currently
 *          has none (instructions: [] or missing) - e.g. the hand-authored
 *          batch scripts/import-hand-authored-recipes.js created without
 *          any (see scripts/backfill-hand-authored-recipe-steps.js, the
 *          equivalent direct-DB-access script this endpoint mirrors).
 *
 *          Exists as an HTTP route, not just a script, because prod's
 *          MongoDB has no public IP (self-hosted on a private-subnet-only
 *          Oracle VM - see docs/db-migration-oracle.md) and is unreachable
 *          from outside Coolify's network. This process already holds a
 *          correctly-configured connection to whichever DB it's actually
 *          running against (dev or prod), so calling it as dietician-
 *          authenticated dietician herself, over the same HTTPS API the
 *          app already exposes, needs no direct database access or
 *          connection string at all - see scripts/trigger-cooking-steps-
 *          backfill.js, a thin HTTP client for this route.
 *
 *          Dry-run by default (generates and returns the steps without
 *          saving) - pass ?execute=true to actually write them.
 * @route   POST /api/dietician/recipes/backfill-cooking-steps
 * @access  Private (Dietician)
 * @query   execute ('true' to write; omitted/anything else = dry run)
 */
exports.backfillCookingSteps = async (req, res, next) => {
  try {
    const dieticianId = req.user._id;
    const execute = req.query?.execute === 'true';

    const recipes = await Recipe.find({
      dieticianId,
      $or: [{ instructions: { $size: 0 } }, { instructions: { $exists: false } }],
    }).sort({ servingTime: 1, name: 1 });

    const { syncV1FromRecipe } = require('../../services/recipeVersioningService');
    const { generateCookingStepsForFixedIngredients } = require('../../utils/openaiClient');

    const results = [];
    let updated = 0;
    let failed = 0;

    for (const recipe of recipes) {
      let steps;
      try {
        steps = await generateCookingStepsForFixedIngredients({
          name: recipe.name,
          servingTime: recipe.servingTime,
          ingredients: (recipe.ingredients || []).map((i) => ({
            name: i.name,
            quantity: i.quantity,
            unit: i.unit,
          })),
        });
      } catch (err) {
        failed++;
        results.push({ recipeId: String(recipe._id), name: recipe.name, error: err.message });
        continue;
      }

      if (!Array.isArray(steps) || steps.length === 0) {
        failed++;
        results.push({ recipeId: String(recipe._id), name: recipe.name, error: 'no steps returned' });
        continue;
      }

      if (execute) {
        try {
          recipe.instructions = steps;
          await recipe.save();
          await syncV1FromRecipe(recipe);
          updated++;
        } catch (err) {
          failed++;
          results.push({ recipeId: String(recipe._id), name: recipe.name, error: err.message });
          continue;
        }
      }

      results.push({ recipeId: String(recipe._id), name: recipe.name, steps });
    }

    return res.status(200).json({
      success: true,
      executed: execute,
      summary: { total: recipes.length, updated, failed },
      results,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    List recipes by serving time with optional cuisine filtering
 * @route   GET /api/dietician/recipes/by-serving-time
 * @access  Private (Dietician)
 * @query   servingTime (required), cuisine (optional), page (default 1), limit (default 10, max 50)
 */
exports.listRecipesByServingTime = async (req, res, next) => {
  try {
    const dieticianId = req.user._id;
    const { servingTime, cuisine, topCategory, page = '1', limit = '10' } = req.query || {};

    const VALID_SERVING_TIMES = [
      'Morning Drink',
      'Breakfast',
      'Brunch',
      'Lunch',
      'Evening Snack',
      'Dinner',
      'Night Drink',
    ];

    // Validate servingTime is provided and valid
    if (!servingTime || !VALID_SERVING_TIMES.includes(servingTime)) {
      return res.status(400).json({
        success: false,
        message: `servingTime is required and must be one of: ${VALID_SERVING_TIMES.join(', ')}`,
      });
    }

    // Pagination
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitParsed = parseInt(limit, 10);
    const limitNum = Math.min(Math.max(Number.isNaN(limitParsed) ? 10 : limitParsed, 1), 50);
    const skip = (pageNum - 1) * limitNum;

    // Build filter
    const filter = {
      dieticianId,
      servingTime,
      ...resolveTopCategoryFilter(topCategory),
    };

    if (cuisine) {
      filter.cuisine = cuisine;
    }

    // Supplements are an exclusive shortcut section (see getServingTimeSummary)
    // - they must never appear while browsing a meal-time bucket unless the
    // dietician explicitly scoped this query to Supplements via topCategory.
    if (topCategory !== 'Supplements' && !filter.category) {
      filter.category = { $ne: 'Supplements' };
    }

    // Query with lean() for performance
    const query = Recipe.find(filter)
      .select(
        '_id name image servingTime cuisine ingredients nutrition.calories tagline description createdAt'
      )
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean();

    const [total, recipes] = await Promise.all([Recipe.countDocuments(filter), query]);

    // Transform response
    const data = recipes.map((recipe) => ({
      _id: recipe._id,
      name: recipe.name || null,
      image: recipe.image || null,
      servingTime: recipe.servingTime || null,
      cuisine: recipe.cuisine || null,
      ingredientsCount: Array.isArray(recipe.ingredients) ? recipe.ingredients.length : 0,
      calories: recipe.nutrition?.calories ?? null,
      tagline: recipe.tagline || recipe.description || null,
    }));

    return res.status(200).json({
      success: true,
      data,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        hasMore: skip + recipes.length < total,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get recipes grouped by category (for Recipes & Supplements screen)
 * @route   GET /api/dietician/recipes/categories
 * @access  Private (Dietician)
 * @returns Categories with recipe counts and sample recipes
 */
exports.getRecipeCategories = async (req, res, next) => {
  try {
    const dieticianId = req.user._id;

    // Get all unique categories with counts
    const categoryStats = await Recipe.aggregate([
      { $match: { dieticianId: dieticianId } },
      {
        $group: {
          _id: '$category',
          count: { $sum: 1 },
          sampleImage: { $first: '$image' },
        },
      },
      { $sort: { count: -1 } },
    ]);

    // Get total count
    const totalRecipes = await Recipe.countDocuments({ dieticianId });

    // Build response
    const categories = [
      {
        name: 'All',
        count: totalRecipes,
        image: categoryStats[0]?.sampleImage || null,
      },
      ...categoryStats.map((cat) => ({
        name: cat._id || 'Other',
        count: cat.count,
        image: cat.sampleImage || null,
      })),
    ];

    return res.status(200).json({
      success: true,
      data: categories,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Real recipe counts per serving-time slot, optionally scoped to a
 *          top-level category group, plus the Supplements total - powers
 *          the "Recipes & Supplements" landing grid's per-card counts.
 * @route   GET /api/dietician/recipes/serving-time-summary
 * @access  Private (Dietician)
 * @query   topCategory (optional: All/Indian/Continental/Western/Supplements)
 */
exports.getServingTimeSummary = async (req, res, next) => {
  try {
    const dieticianId = req.user._id;
    const { topCategory } = req.query || {};

    const VALID_SERVING_TIMES = [
      'Morning Drink', 'Breakfast', 'Brunch', 'Lunch', 'Evening Snack', 'Dinner', 'Night Drink',
    ];

    const scopedFilter = { dieticianId, ...resolveTopCategoryFilter(topCategory) };

    // Supplements are counted separately below (supplementsCount) and must
    // not also inflate the per-servingTime meal-time buckets, unless the
    // dietician explicitly scoped this summary to Supplements.
    if (topCategory !== 'Supplements' && !scopedFilter.category) {
      scopedFilter.category = { $ne: 'Supplements' };
    }

    const counts = await Recipe.aggregate([
      { $match: scopedFilter },
      { $group: { _id: '$servingTime', count: { $sum: 1 } } },
    ]);
    const countByServingTime = new Map(counts.map((c) => [c._id, c.count]));

    // Supplements/Sides/Salad are fixed shortcut cards regardless of the
    // selected top category, since none of them are tied to one cuisine.
    const [supplementsCount, sidesCount, saladCount] = await Promise.all([
      Recipe.countDocuments({ dieticianId, category: 'Supplements' }),
      Recipe.countDocuments({ dieticianId, tags: 'side' }),
      Recipe.countDocuments({ dieticianId, tags: 'salad' }),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        servingTimeCounts: VALID_SERVING_TIMES.map((st) => ({
          servingTime: st,
          count: countByServingTime.get(st) || 0,
        })),
        sidesCount,
        saladCount,
        supplementsCount,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    List all recipes with optional category filter
 * @route   GET /api/dietician/recipes
 * @access  Private (Dietician)
 * @query   category (optional exact match), topCategory (optional group:
 *          All/Indian/Continental/Western/Supplements), servingTime
 *          (optional), tag (optional: side/salad, matches if the recipe's
 *          tags array contains it), page (default 1), limit (default 20)
 */
exports.listRecipes = async (req, res, next) => {
  try {
    const dieticianId = req.user._id;
    const { category, topCategory, servingTime, tag, page = '1', limit = '20' } = req.query || {};

    // Pagination
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitParsed = parseInt(limit, 10);
    const limitNum = Math.min(Math.max(Number.isNaN(limitParsed) ? 20 : limitParsed, 1), 100);
    const skip = (pageNum - 1) * limitNum;

    // Build filter
    const filter = { dieticianId, ...resolveTopCategoryFilter(topCategory) };
    if (category && category !== 'All') {
      filter.category = category;
    }
    if (tag) {
      filter.tags = tag;
    } else if (servingTime && SIDE_SALAD_ELIGIBLE_SLOTS.has(servingTime)) {
      // Same cross-listing eligibility the AI generation engine already
      // uses (services/recipeSelectionEngine.js) - a side/salad-tagged
      // recipe is a legitimate accompaniment for Lunch/Dinner regardless of
      // its own authored servingTime, so a dietician manually adding/
      // swapping a recipe for one of those slots should see it too.
      // Evening Snack is intentionally NOT in SIDE_SALAD_ELIGIBLE_SLOTS - a
      // lunch/dinner side is never a legitimate evening snack.
      // Skipped when an explicit `tag` filter is requested - that caller
      // already knows exactly which tag it wants, no broadening needed.
      filter.$or = [{ servingTime }, { tags: { $in: ['side', 'salad'] } }];
    } else if (servingTime) {
      filter.servingTime = servingTime;
    }

    // Supplements are an exclusive shortcut section - never mix into a
    // general/meal-time listing unless explicitly requested.
    if (category !== 'Supplements' && topCategory !== 'Supplements' && !filter.category) {
      filter.category = { $ne: 'Supplements' };
    }

    // Query recipes
    const [total, recipes] = await Promise.all([
      Recipe.countDocuments(filter),
      Recipe.find(filter)
        .select(
          '_id name image category cuisine servingTime servings ingredients nutrition.calories description createdAt tags'
        )
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
    ]);

    // Transform response
    const data = recipes.map((recipe) => ({
      id: recipe._id,
      name: recipe.name || '',
      image: recipe.image || null,
      category: recipe.category || 'Other',
      cuisine: recipe.cuisine || '',
      servingTime: recipe.servingTime || '',
      servings: recipe.servings || 1,
      ingredientsCount: Array.isArray(recipe.ingredients) ? recipe.ingredients.length : 0,
      calories: recipe.nutrition?.calories ?? null,
      description: recipe.description || '',
      createdAt: recipe.createdAt,
      tags: Array.isArray(recipe.tags) ? recipe.tags : [],
    }));

    return res.status(200).json({
      success: true,
      data,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        hasMore: skip + recipes.length < total,
      },
    });
  } catch (error) {
    next(error);
  }
};

// Fields that can be updated as-is (Mongoose's own schema validators, run
// via runValidators below, catch invalid enum values for these).
const DIRECT_UPDATE_FIELDS = [
  'image', 'description', 'servingTime', 'servings', 'dietaryHabits',
  'freeFrom', 'nutrition', 'translations',
];

/**
 * @desc    Update an existing recipe - either a single field (e.g. just the
 *          main image) or the full editable set from the "Save Recipe"
 *          button on an already-saved recipe's detail screen (ingredients -
 *          including any refreshed images, instructions, nutrition, etc.).
 *          Previously this only ever supported `image`, meaning edits made
 *          via "Update AI Inputs" on an existing recipe (and any ingredient
 *          image refresh) never actually reached the database.
 * @route   PATCH /api/dietician/recipes/:id
 * @access  Private (Dietician)
 */
exports.updateRecipe = async (req, res, next) => {
  try {
    const dieticianId = req.user._id;
    const { id } = req.params;
    const body = req.body || {};

    const updates = {};
    const unsets = {};
    for (const key of DIRECT_UPDATE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        updates[key] = body[key];
      }
    }
    if (Object.prototype.hasOwnProperty.call(body, 'category')) {
      updates.category = VALID_CATEGORIES.includes(body.category) ? body.category : 'Indian';
    }
    if (Object.prototype.hasOwnProperty.call(body, 'ingredients')) {
      const { ingredients: safeIngredients } = sanitizeRecipeIngredients(body.ingredients);
      updates.ingredients = safeIngredients;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'components')) {
      const safeComponents = sanitizeRecipeComponents(body.components);
      if (safeComponents) {
        updates.components = safeComponents;
        // Keep the legacy servingSize/secondaryComponent mirrors in sync
        // (see models/Recipe.js's doc comment) so consumers not yet reading
        // `components` directly don't go stale after an edit.
        updates.servingSize = {
          quantity: safeComponents[0].quantity,
          unit: safeComponents[0].unit,
        };
        if (safeComponents[1]) {
          updates.secondaryComponent = {
            label: safeComponents[1].label,
            quantity: safeComponents[1].quantity,
            unit: safeComponents[1].unit,
          };
        } else {
          // $set can't reliably clear a field to "absent" - use $unset so a
          // recipe edited down from 2 components to 1 doesn't keep a stale
          // secondaryComponent mirror.
          unsets.secondaryComponent = '';
        }
      }
    }
    if (Object.prototype.hasOwnProperty.call(body, 'instructions')) {
      updates.instructions = body.instructions;
    } else if (Object.prototype.hasOwnProperty.call(body, 'cookingSteps')) {
      updates.instructions = body.cookingSteps;
    }

    if (Object.keys(updates).length === 0 && Object.keys(unsets).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No updatable fields provided',
      });
    }

    const recipe = await Recipe.findOneAndUpdate(
      { _id: id, dieticianId },
      {
        ...(Object.keys(updates).length > 0 ? { $set: updates } : {}),
        ...(Object.keys(unsets).length > 0 ? { $unset: unsets } : {}),
      },
      { new: true, runValidators: true }
    ).lean();

    if (!recipe) {
      return res.status(404).json({
        success: false,
        message: 'Recipe not found',
      });
    }

    return res.status(200).json({
      success: true,
      data: recipe,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get single recipe by ID
 * @route   GET /api/dietician/recipes/:id
 * @access  Private (Dietician)
 */
exports.getRecipeById = async (req, res, next) => {
  try {
    const dieticianId = req.user._id;
    const { id } = req.params;

    const recipe = await Recipe.findOne({ _id: id, dieticianId }).lean();

    if (!recipe) {
      return res.status(404).json({
        success: false,
        message: 'Recipe not found',
      });
    }

    const responseData = {
      ...recipe,
      cookingSteps: recipe.instructions || [],
    };
    delete responseData.instructions;

    return res.status(200).json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    next(error);
  }
};
