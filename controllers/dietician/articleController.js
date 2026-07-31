const Article = require('../../models/Article');
const cloudinary = require('../../config/cloudinary');
const { cloudinaryUserFolder } = require('../../utils/cloudinaryFolder');
const { resolvePatientDieticianId } = require('../../utils/resolvePatientDieticianId');
const fs = require('fs');

/**
 * @desc    Add an article (image uploaded to Cloudinary)
 * @route   POST /api/dietician/articles
 * @access  Dietician only
 */
exports.addArticle = async (req, res) => {
  try {
    const dieticianId = req.user._id;
    const { title, category, excerpt, content, isActive } = req.body;

    if (!title) {
      return res.status(400).json({ success: false, message: 'title is required' });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Image is required' });
    }

    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: cloudinaryUserFolder(dieticianId, 'articles'),
      transformation: [{ quality: 'auto', fetch_format: 'auto' }],
    });
    fs.unlink(req.file.path, () => {});

    const count = await Article.countDocuments({ dieticianId });

    const article = await Article.create({
      dieticianId,
      title,
      category: category || '',
      imageUrl: result.secure_url,
      cloudinaryPublicId: result.public_id,
      excerpt: excerpt || '',
      content: content || '',
      order: count,
      isActive: isActive === undefined ? true : isActive === true || isActive === 'true',
    });

    return res.status(201).json({ success: true, message: 'Article added', data: article });
  } catch (error) {
    console.error('addArticle error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * @desc    Get all of the dietician's articles
 * @route   GET /api/dietician/articles
 * @access  Dietician only
 */
exports.getArticles = async (req, res) => {
  try {
    const articles = await Article.find({ dieticianId: req.user._id }).sort({ order: 1 }).lean();
    return res.status(200).json({ success: true, data: articles });
  } catch (error) {
    console.error('getArticles error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * @desc    Update an article (replace image, edit text, toggle active)
 * @route   PUT /api/dietician/articles/:id
 * @access  Dietician only
 */
exports.updateArticle = async (req, res) => {
  try {
    const dieticianId = req.user._id;
    const article = await Article.findOne({ _id: req.params.id, dieticianId });
    if (!article) {
      return res.status(404).json({ success: false, message: 'Article not found' });
    }

    if (req.file) {
      if (article.cloudinaryPublicId) {
        await cloudinary.uploader.destroy(article.cloudinaryPublicId).catch(() => {});
      }
      const result = await cloudinary.uploader.upload(req.file.path, {
        folder: cloudinaryUserFolder(dieticianId, 'articles'),
        transformation: [{ quality: 'auto', fetch_format: 'auto' }],
      });
      fs.unlink(req.file.path, () => {});
      article.imageUrl = result.secure_url;
      article.cloudinaryPublicId = result.public_id;
    }

    if (req.body.title !== undefined) article.title = req.body.title;
    if (req.body.category !== undefined) article.category = req.body.category;
    if (req.body.excerpt !== undefined) article.excerpt = req.body.excerpt;
    if (req.body.content !== undefined) article.content = req.body.content;
    if (req.body.isActive !== undefined) {
      article.isActive = req.body.isActive === true || req.body.isActive === 'true';
    }

    await article.save();
    return res.status(200).json({ success: true, message: 'Article updated', data: article });
  } catch (error) {
    console.error('updateArticle error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * @desc    Delete an article
 * @route   DELETE /api/dietician/articles/:id
 * @access  Dietician only
 */
exports.deleteArticle = async (req, res) => {
  try {
    const article = await Article.findOneAndDelete({ _id: req.params.id, dieticianId: req.user._id });
    if (!article) {
      return res.status(404).json({ success: false, message: 'Article not found' });
    }
    if (article.cloudinaryPublicId) {
      await cloudinary.uploader.destroy(article.cloudinaryPublicId).catch(() => {});
    }
    return res.status(200).json({ success: true, message: 'Article deleted' });
  } catch (error) {
    console.error('deleteArticle error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * @desc    Persist a new display order (drag-reorder on the dietician app)
 * @route   PUT /api/dietician/articles/reorder
 * @body    { orderedIds: string[] }
 * @access  Dietician only
 */
exports.reorderArticles = async (req, res) => {
  try {
    const dieticianId = req.user._id;
    const { orderedIds } = req.body;

    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      return res.status(400).json({ success: false, message: 'orderedIds must be a non-empty array' });
    }

    await Promise.all(
      orderedIds.map((id, index) => Article.updateOne({ _id: id, dieticianId }, { order: index }))
    );

    return res.status(200).json({ success: true, message: 'Order updated' });
  } catch (error) {
    console.error('reorderArticles error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * @desc    Get the assigned dietician's active articles
 * @route   GET /api/patient/articles
 * @access  Patient only
 */
exports.getActiveArticlesForPatient = async (req, res) => {
  try {
    const dieticianId = await resolvePatientDieticianId(req.user._id);
    if (!dieticianId) {
      return res.status(200).json({ success: true, data: [] });
    }

    const articles = await Article.find({ dieticianId, isActive: true }).sort({ order: 1 }).lean();
    return res.status(200).json({ success: true, data: articles });
  } catch (error) {
    console.error('getActiveArticlesForPatient error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};
