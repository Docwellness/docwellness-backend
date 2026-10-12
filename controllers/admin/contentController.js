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
    if (req.query.q) and.push({ name: new RegExp(escapeRegex(String(req.query.q).slice(0, 80)), 'i') });
    const filter = { $and: and };

    const [rows, total] = await Promise.all([
      Recipe.find(filter)
        .select('name category image imageSource servingTime dieticianId translations')
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
      image: r.image || null,
      imageSource: r.imageSource || null,
      translations: { Hindi: hasTranslation(r, 'Hindi'), Marathi: hasTranslation(r, 'Marathi') },
    }));
    res.json({ success: true, data: { items, total, page, limit } });
  } catch (err) {
    next(err);
  }
};

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


