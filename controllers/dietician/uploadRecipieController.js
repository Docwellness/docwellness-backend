const Recipe = require('../../models/Recipe');
const { generateRecipeWithAI } = require('../../utils/openaiClient');
const cloudinary = require('../../config/cloudinary');
const fs = require('fs');

exports.uploadRecipeImage = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Image file is required',
      });
    }

    const uploadResult = await cloudinary.uploader.upload(req.file.path, {
      folder: 'docwellness/recipes/main',
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
      folder: 'docwellness/recipes/ingredients',
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

    // Parse languages from comma-separated string
    const languages = language
      ? language.split(',').map((l) => l.trim()).filter(Boolean)
      : ['English'];

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

    return res.status(200).json({
      success: true,
      data: previewRecipe,
    });
  } catch (error) {
    next(error);
  }
};

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

    // Allowed enum values from Recipe schema
    const VALID_CATEGORIES = [
      'Indian', 'American', 'British', 'Mediterranean', 'Asian', 'Mexican',
      'Italian', 'French', 'Middle Eastern', 'Japanese', 'Chinese', 'Thai',
      'Korean', 'Continental', 'Fusion', 'Healthy Bowls', 'Smoothies & Drinks',
      'Supplements', 'Keto', 'Vegan Specials', 'High Protein', 'Low Carb',
      'Detox', 'Other',
    ];
    const VALID_UNITS = ['g', 'ml', 'cup', 'tbsp', 'tsp', 'piece'];
    const VALID_PRICE_LEVELS = ['$', '$$', '$$$', '₹', '₹₹', '₹₹₹', '£', '££', '£££'];
    const VALID_INGREDIENT_CATEGORIES = [
      'Protein Rich', 'Carbohydrate', 'Vegetable', 'Dairy', 'Spice', 'Oil/Fat',
      'Sweetener', 'Grain', 'Legume', 'Nut/Seed', 'Fruit', 'Herb',
      'Sauce/Condiment', 'Other',
    ];

    // Sanitize category to match schema enum
    const safeCategory = VALID_CATEGORIES.includes(category) ? category : 'Indian';

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

    // Sanitize ingredient enum fields so Mongoose validation doesn't reject the whole doc
    const safeIngredients = Array.isArray(ingredients)
      ? ingredients.map((ing) => ({
        ...ing,
        quantity: parseQuantity(ing.quantity),
        unit: VALID_UNITS.includes(ing.unit) ? ing.unit : 'g',
        priceLevel: VALID_PRICE_LEVELS.includes(ing.priceLevel) ? ing.priceLevel : '₹₹',
        category: VALID_INGREDIENT_CATEGORIES.includes(ing.category) ? ing.category : 'Other',
      }))
      : [];

    // Parse languages from comma-separated string or array
    let languages;
    if (Array.isArray(language)) {
      languages = language;
    } else if (typeof language === 'string') {
      languages = language.split(',').map((l) => l.trim()).filter(Boolean);
    } else {
      languages = ['English'];
    }

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
      ingredients: safeIngredients,
      instructions: cookingSteps,
      nutrition,
      image,
      language: languages,
      translations: translations || {},
    });

    return res.status(201).json({
      success: true,
      data: recipe,
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

    const finalWarnings = Array.isArray(updatedRecipe.warnings) ? updatedRecipe.warnings : [];

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
      ingredients: finalIngredients,
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
 * @desc    List recipes by serving time with optional cuisine filtering
 * @route   GET /api/dietician/recipes/by-serving-time
 * @access  Private (Dietician)
 * @query   servingTime (required), cuisine (optional), page (default 1), limit (default 10, max 50)
 */
exports.listRecipesByServingTime = async (req, res, next) => {
  try {
    const dieticianId = req.user._id;
    const { servingTime, cuisine, page = '1', limit = '10' } = req.query || {};

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
    };

    if (cuisine) {
      filter.cuisine = cuisine;
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
 * @desc    List all recipes with optional category filter
 * @route   GET /api/dietician/recipes
 * @access  Private (Dietician)
 * @query   category (optional), page (default 1), limit (default 20)
 */
exports.listRecipes = async (req, res, next) => {
  try {
    const dieticianId = req.user._id;
    const { category, page = '1', limit = '20' } = req.query || {};

    // Pagination
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitParsed = parseInt(limit, 10);
    const limitNum = Math.min(Math.max(Number.isNaN(limitParsed) ? 20 : limitParsed, 1), 100);
    const skip = (pageNum - 1) * limitNum;

    // Build filter
    const filter = { dieticianId };
    if (category && category !== 'All') {
      filter.category = category;
    }

    // Query recipes
    const [total, recipes] = await Promise.all([
      Recipe.countDocuments(filter),
      Recipe.find(filter)
        .select(
          '_id name image category cuisine servingTime servings ingredients nutrition.calories description createdAt'
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
 * @desc    Update selected fields on an existing recipe
 * @route   PATCH /api/dietician/recipes/:id
 * @access  Private (Dietician)
 *
 * Currently supports updating:
 *   - image (string URL)
 * More fields can be whitelisted below as needed.
 */
exports.updateRecipe = async (req, res, next) => {
  try {
    const dieticianId = req.user._id;
    const { id } = req.params;

    const allowed = ['image'];
    const updates = {};
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, key)) {
        updates[key] = req.body[key];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No updatable fields provided',
      });
    }

    const recipe = await Recipe.findOneAndUpdate(
      { _id: id, dieticianId },
      { $set: updates },
      { new: true }
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
