const SocialMediaPost = require('../../models/SocialMediaPost');
const cloudinary = require('../../config/cloudinary');
const { cloudinaryUserFolder } = require('../../utils/cloudinaryFolder');
const { resolvePatientDieticianId } = require('../../utils/resolvePatientDieticianId');
const fs = require('fs');

// Covers youtube.com/watch?v=, youtu.be/, and youtube.com/shorts/ - the
// three URL shapes the dietician is likely to paste in.
function extractYoutubeId(url) {
  const match = url.match(
    /(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/
  );
  return match ? match[1] : null;
}

/**
 * @desc    Add a social media post (YouTube link or Instagram card)
 * @route   POST /api/dietician/social-media
 * @access  Dietician only
 */
exports.addSocialPost = async (req, res) => {
  try {
    const dieticianId = req.user._id;
    const { platform, url, caption, isActive } = req.body;

    if (!platform || !['youtube', 'instagram'].includes(platform)) {
      return res.status(400).json({ success: false, message: 'platform must be "youtube" or "instagram"' });
    }
    if (!url) {
      return res.status(400).json({ success: false, message: 'url is required' });
    }

    let thumbnailUrl = '';
    let cloudinaryPublicId = '';

    if (platform === 'youtube') {
      const videoId = extractYoutubeId(url);
      thumbnailUrl = videoId ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` : '';
    } else {
      // Instagram has no public thumbnail API - a manually-uploaded image
      // is required for the vertical card.
      if (!req.file) {
        return res.status(400).json({ success: false, message: 'A thumbnail image is required for Instagram posts' });
      }
      const result = await cloudinary.uploader.upload(req.file.path, {
        folder: cloudinaryUserFolder(dieticianId, 'social-media'),
        transformation: [{ quality: 'auto', fetch_format: 'auto' }],
      });
      fs.unlink(req.file.path, () => {});
      thumbnailUrl = result.secure_url;
      cloudinaryPublicId = result.public_id;
    }

    const count = await SocialMediaPost.countDocuments({ dieticianId, platform });

    const post = await SocialMediaPost.create({
      dieticianId,
      platform,
      url,
      thumbnailUrl,
      cloudinaryPublicId,
      caption: caption || '',
      order: count,
      isActive: isActive === undefined ? true : isActive === true || isActive === 'true',
    });

    return res.status(201).json({ success: true, message: 'Social post added', data: post });
  } catch (error) {
    console.error('addSocialPost error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * @desc    Get all of the dietician's social posts (both platforms)
 * @route   GET /api/dietician/social-media
 * @access  Dietician only
 */
exports.getSocialPosts = async (req, res) => {
  try {
    const posts = await SocialMediaPost.find({ dieticianId: req.user._id })
      .sort({ platform: 1, order: 1 })
      .lean();
    return res.status(200).json({ success: true, data: posts });
  } catch (error) {
    console.error('getSocialPosts error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * @desc    Update a social post (caption, active state, or replace the URL/thumbnail)
 * @route   PUT /api/dietician/social-media/:id
 * @access  Dietician only
 */
exports.updateSocialPost = async (req, res) => {
  try {
    const dieticianId = req.user._id;
    const post = await SocialMediaPost.findOne({ _id: req.params.id, dieticianId });
    if (!post) {
      return res.status(404).json({ success: false, message: 'Social post not found' });
    }

    if (req.body.url !== undefined) {
      post.url = req.body.url;
      if (post.platform === 'youtube') {
        const videoId = extractYoutubeId(post.url);
        post.thumbnailUrl = videoId ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` : post.thumbnailUrl;
      }
    }

    if (req.file && post.platform === 'instagram') {
      if (post.cloudinaryPublicId) {
        await cloudinary.uploader.destroy(post.cloudinaryPublicId).catch(() => {});
      }
      const result = await cloudinary.uploader.upload(req.file.path, {
        folder: cloudinaryUserFolder(dieticianId, 'social-media'),
        transformation: [{ quality: 'auto', fetch_format: 'auto' }],
      });
      fs.unlink(req.file.path, () => {});
      post.thumbnailUrl = result.secure_url;
      post.cloudinaryPublicId = result.public_id;
    }

    if (req.body.caption !== undefined) post.caption = req.body.caption;
    if (req.body.isActive !== undefined) {
      post.isActive = req.body.isActive === true || req.body.isActive === 'true';
    }

    await post.save();
    return res.status(200).json({ success: true, message: 'Social post updated', data: post });
  } catch (error) {
    console.error('updateSocialPost error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * @desc    Delete a social post
 * @route   DELETE /api/dietician/social-media/:id
 * @access  Dietician only
 */
exports.deleteSocialPost = async (req, res) => {
  try {
    const post = await SocialMediaPost.findOneAndDelete({ _id: req.params.id, dieticianId: req.user._id });
    if (!post) {
      return res.status(404).json({ success: false, message: 'Social post not found' });
    }
    if (post.cloudinaryPublicId) {
      await cloudinary.uploader.destroy(post.cloudinaryPublicId).catch(() => {});
    }
    return res.status(200).json({ success: true, message: 'Social post deleted' });
  } catch (error) {
    console.error('deleteSocialPost error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * @desc    Persist a new display order for one platform's posts (drag-reorder)
 * @route   PUT /api/dietician/social-media/reorder
 * @body    { platform: 'youtube'|'instagram', orderedIds: string[] }
 * @access  Dietician only
 */
exports.reorderSocialPosts = async (req, res) => {
  try {
    const dieticianId = req.user._id;
    const { platform, orderedIds } = req.body;

    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      return res.status(400).json({ success: false, message: 'orderedIds must be a non-empty array' });
    }

    await Promise.all(
      orderedIds.map((id, index) =>
        SocialMediaPost.updateOne({ _id: id, dieticianId, platform }, { order: index })
      )
    );

    return res.status(200).json({ success: true, message: 'Order updated' });
  } catch (error) {
    console.error('reorderSocialPosts error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * @desc    Get the assigned dietician's active social posts (grouped by platform)
 * @route   GET /api/patient/social-media
 * @access  Patient only
 */
exports.getActiveSocialPostsForPatient = async (req, res) => {
  try {
    const dieticianId = await resolvePatientDieticianId(req.user._id);
    if (!dieticianId) {
      return res.status(200).json({ success: true, data: { youtube: [], instagram: [] } });
    }

    const posts = await SocialMediaPost.find({ dieticianId, isActive: true })
      .sort({ order: 1 })
      .lean();

    return res.status(200).json({
      success: true,
      data: {
        youtube: posts.filter((p) => p.platform === 'youtube'),
        instagram: posts.filter((p) => p.platform === 'instagram'),
      },
    });
  } catch (error) {
    console.error('getActiveSocialPostsForPatient error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};
