const fs = require('fs');
const cloudinary = require('../../config/cloudinary');
const Recipe = require('../../models/Recipe');
const mongoose = require('mongoose');
const User = require('../../models/User');
const { audited } = require('../../utils/adminAudit');
const { sponsoredLabelOf } = require('../../utils/sponsored');

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const missingImage = { $or: [{ image: { $exists: false } }, { image: null }, { image: '' }] };

function imageStatusFilter(status) {
  switch (status) {
    case 'missing':
      return missingImage;
    case 'has':
      return { image: { $nin: [null, ''], $exists: true } };
    case 'commercial':
      return { imageSource: 'commercial' };
    default:
      return {};
  }
}

const hasTranslation = (r, lang) => {
  const t = r.translations && r.translations[lang];
  return Boolean(t && t.name && Array.isArray(t.cookingSteps) && t.cookingSteps.length > 0);
};

// GET /api/admin/content/recipes?q=&category=&imageStatus=&page=&limit=
exports.listRecipes = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const and = [imageStatusFilter(req.query.imageStatus)];
    if (req.query.category) and.push({ category: req.query.category });
    if (req.query.dieticianId) {
      if (!mongoose.Types.ObjectId.isValid(req.query.dieticianId)) {
        return res.status(400).json({ success: false, message: 'Invalid dietician id' });
      }
      and.push({ dieticianId: req.query.dieticianId });
    }
    if (req.query.q) and.push({ name: new RegExp(escapeRegex(String(req.query.q).slice(0, 80)), 'i') });
    const filter = { $and: and };

    const [rows, total] = await Promise.all([
      Recipe.find(filter)
        .select('name category image imageSource servingTime dieticianId translations nutrition.calories')
        .sort({ name: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Recipe.countDocuments(filter),
    ]);

    const items = rows.map((r) => ({
      _id: r._id,
      name: r.name,
      category: r.category,
      servingTime: r.servingTime,
      calories: r.nutrition?.calories ?? null,
      image: r.image || null,
      imageSource: r.imageSource || null,
      translations: { Hindi: hasTranslation(r, 'Hindi'), Marathi: hasTranslation(r, 'Marathi') },
    }));
    res.json({ success: true, data: { items, total, page, limit } });
  } catch (err) {
    next(err);
  }
};

// GET /api/admin/content/ingredients?dieticianId=&q=
// Every distinct ingredient across a dietician's recipes. Names are compared
// case-insensitively with whitespace collapsed, so "Ragi flour" and "Ragi Flour" are one row.
exports.listIngredients = async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.query.dieticianId)) {
      return res.status(400).json({ success: false, message: 'Invalid dietician id' });
    }
    const q = req.query.q ? String(req.query.q).trim().slice(0, 80) : '';
    const recipes = await Recipe.find({ dieticianId: req.query.dieticianId })
      .select('ingredients.name ingredients.category ingredients.image')
      .lean();
    const needle = q.toLowerCase();
    const byKey = new Map();
    for (const r of recipes) {
      const seenInRecipe = new Set();
      for (const i of r.ingredients || []) {
        const name = String(i.name || '').trim().replace(/\s+/g, ' ');
        const key = name.toLowerCase();
        if (!key || (needle && !key.includes(needle))) continue;
        const row = byKey.get(key) || { key, name, category: i.category || null, image: null, recipeCount: 0 };
        if (!row.image && i.image) row.image = i.image;
        if (!seenInRecipe.has(key)) {
          seenInRecipe.add(key);
          row.recipeCount += 1;
        }
        byKey.set(key, row);
      }
    }
    const rows = [...byKey.values()].sort((x, y) => x.name.localeCompare(y.name, 'en', { sensitivity: 'base' }));
    res.json({ success: true, data: { items: rows, total: rows.length } });
  } catch (err) {
    next(err);
  }
};

const Ingredient = require('../../models/Ingredient');

const INGREDIENT_CATEGORIES = Recipe.schema.path('ingredients').schema.path('category').enumValues;

// Case/whitespace-insensitive exact match for an ingredient name, the same rule listIngredients groups by.
const ingredientNameRegex = (key) =>
  new RegExp(`^\s*${String(key).trim().split(/\s+/).map(escapeRegex).join('\s+')}\s*$`, 'i');

// PATCH /api/admin/content/ingredients  (multipart: dieticianId, key, name?, category?, image?)
// Applies to every occurrence of that ingredient across the dietician's recipes.
exports.updateIngredient = async (req, res, next) => {
  const tmp = req.file?.path;
  try {
    const { dieticianId, key } = req.body;
    if (!mongoose.Types.ObjectId.isValid(dieticianId) || !key || !String(key).trim()) {
      return res.status(400).json({ success: false, message: 'dieticianId and key are required' });
    }
    const name = req.body.name === undefined ? undefined : String(req.body.name).trim().replace(/\s+/g, ' ');
    if (name !== undefined && (name.length < 1 || name.length > 80)) {
      return res.status(400).json({ success: false, message: 'Name must be 1-80 characters' });
    }
    const category = req.body.category || undefined;
    if (category && !INGREDIENT_CATEGORIES.includes(category)) {
      return res.status(400).json({ success: false, message: 'Unknown category' });
    }
    if (name === undefined && !category && !req.file) {
      return res.status(400).json({ success: false, message: 'Nothing to change' });
    }

    const owner = new mongoose.Types.ObjectId(dieticianId);
    const rx = ingredientNameRegex(key);
    const matching = { dieticianId: owner, ingredients: { $elemMatch: { name: rx } } };
    const affected = await Recipe.countDocuments(matching);
    if (!affected) return res.status(404).json({ success: false, message: 'Ingredient not found' });

    let image;
    if (req.file) {
      const upload = await cloudinary.uploader.upload(req.file.path, {
        folder: 'docwellness/admin/recipes/ingredients',
      });
      image = upload.secure_url || upload.url;
      if (!image) throw new Error('Image upload returned no URL');
    }

    const set = {};
    if (name !== undefined) set['ingredients.$[i].name'] = name;
    if (category) set['ingredients.$[i].category'] = category;
    if (image) set['ingredients.$[i].image'] = image;
    const after = { ...(name !== undefined && { name }), ...(category && { category }), ...(image && { image }) };

    await audited(
      req,
      {
        action: 'content.ingredient.update',
        targetType: 'ingredient',
        targetId: String(key).trim().toLowerCase().slice(0, 80),
        after,
        meta: { dieticianId, recipes: affected },
      },
      async () => {
        await Recipe.updateMany(matching, { $set: set }, { arrayFilters: [{ 'i.name': rx }] });
        if (name !== undefined) {
          // Keep component labels that are just the ingredient's name in step with the rename.
          await Recipe.updateMany(
            { dieticianId: owner, components: { $elemMatch: { label: rx } } },
            { $set: { 'components.$[c].label': name } },
            { arrayFilters: [{ 'c.label': rx }] }
          );
        }
        // The canonical per-dietician registry row, when there is one.
        const canon = { ...(category && { category }), ...(image && { image }) };
        const normalizedKey = String(key).trim().toLowerCase().replace(/\s+/g, ' ');
        const row = await Ingredient.findOne({ dieticianId: owner, normalizedName: normalizedKey }).lean();
        if (row) {
          if (name !== undefined) {
            const clash = await Ingredient.exists({
              dieticianId: owner,
              normalizedName: name.toLowerCase(),
              _id: { $ne: row._id },
            });
            if (!clash) Object.assign(canon, { name, normalizedName: name.toLowerCase() });
          }
          if (Object.keys(canon).length) await Ingredient.updateOne({ _id: row._id }, { $set: canon });
        }
      }
    );

    res.json({ success: true, data: { key: (name ?? String(key)).toLowerCase(), recipes: affected, ...after } });
  } catch (err) {
    next(err);
  } finally {
    if (tmp) fs.unlink(tmp, () => {});
  }
};

// GET /api/admin/content/ingredient-categories
exports.ingredientCategories = (req, res) => res.json({ success: true, data: INGREDIENT_CATEGORIES });

// GET /api/admin/content/recipes/:id  - everything the dietician app shows on a recipe, read-only
exports.getRecipe = async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid recipe id' });
    }
    const recipe = await Recipe.findById(req.params.id).lean();
    if (!recipe) return res.status(404).json({ success: false, message: 'Recipe not found' });
    const owner = await User.findById(recipe.dieticianId).select('profile.fullName').lean();
    const translations = Object.fromEntries(
      recipe.translations instanceof Map ? recipe.translations : Object.entries(recipe.translations || {})
    );
    const data = {
      ...recipe,
      translations,
      cookingSteps: recipe.instructions || [],
      sponsoredLabel: sponsoredLabelOf(recipe),
      ownerName: owner?.profile?.fullName || '',
      ownerId: recipe.dieticianId ? String(recipe.dieticianId) : null,
    };
    delete data.instructions;
    delete data.dieticianId;
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

// GET /api/admin/content/recipes/summary
exports.recipeSummary = async (req, res, next) => {
  try {
    const [total, missing, commercial, ai, admin, dietician] = await Promise.all([
      Recipe.countDocuments({}),
      Recipe.countDocuments(missingImage),
      Recipe.countDocuments({ imageSource: 'commercial' }),
      Recipe.countDocuments({ imageSource: 'ai-generated' }),
      Recipe.countDocuments({ imageSource: 'admin-uploaded' }),
      Recipe.countDocuments({ imageSource: 'dietician-uploaded' }),
    ]);
    const categories = await Recipe.aggregate([
      { $match: missingImage },
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);
    res.json({
      success: true,
      data: {
        total,
        missing,
        bySource: { commercial, aiGenerated: ai, adminUploaded: admin, dieticianUploaded: dietician },
        missingByCategory: categories.map((c) => ({ category: c._id || 'Uncategorised', count: c.count })),
      },
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/admin/content/categories
exports.recipeCategories = async (req, res, next) => {
  try {
    const cats = await Recipe.distinct('category');
    res.json({ success: true, data: cats.filter(Boolean).sort() });
  } catch (err) {
    next(err);
  }
};

// POST /api/admin/content/recipes/:id/image  (multipart field "image")
exports.setRecipeImage = async (req, res, next) => {
  const tmp = req.file?.path;
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'An image file is required' });
    }
    const recipe = await Recipe.findById(req.params.id);
    if (!recipe) return res.status(404).json({ success: false, message: 'Recipe not found' });

    if (recipe.imageSource === 'commercial') {
      return res.status(409).json({
        success: false,
        code: 'under_placement',
        message: 'This entry has an active commercial placement. Change it from Product placements.',
      });
    }

    const upload = await cloudinary.uploader.upload(req.file.path, {
      folder: 'docwellness/admin/recipes/main',
    });
    const url = upload.secure_url || upload.url;
    if (!url) throw new Error('Image upload returned no URL');

    const before = { image: recipe.image || null, imageSource: recipe.imageSource || null };
    const after = { image: url, imageSource: 'admin-uploaded' };

    await audited(
      req,
      {
        action: 'content.recipe.set_image',
        targetType: 'recipe',
        targetId: String(recipe._id),
        before,
        after,
        meta: { name: recipe.name },
      },
      async () => {
        const update = { $set: after };
        if (before.image) {
          update.$push = {
            imageHistory: {
              $each: [
                {
                  image: before.image,
                  imageSource: before.imageSource,
                  replacedAt: new Date(),
                  replacedBy: req.admin.email,
                },
              ],
              $position: 0,
              $slice: 20,
            },
          };
        }
        await Recipe.updateOne({ _id: recipe._id }, update);
      }
    );

    res.json({ success: true, data: { _id: recipe._id, ...after } });
  } catch (err) {
    next(err);
  } finally {
    if (tmp) fs.unlink(tmp, () => {});
  }
};


