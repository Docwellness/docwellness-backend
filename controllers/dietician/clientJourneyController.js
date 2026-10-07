const fs = require('fs');
const ClientJourney = require('../../models/ClientJourney');
const { DietPlan } = require('../../models');
const cloudinary = require('../../config/cloudinary');
const { cloudinaryUserFolder } = require('../../utils/cloudinaryFolder');
const config = require('../../config/environment');

const IMAGE_FIELDS = ['beforeImage', 'afterImage', 'reviewImage'];

const isTrue = (v) => v === true || v === 'true';

async function uploadField(req, field, dieticianId) {
  const file = req.files?.[field]?.[0];
  if (!file) return null;
  try {
    const result = await cloudinary.uploader.upload(file.path, {
      folder: cloudinaryUserFolder(dieticianId, 'client-journeys'),
      transformation: [{ quality: 'auto', fetch_format: 'auto' }],
    });
    return { url: result.secure_url, publicId: result.public_id };
  } finally {
    fs.unlink(file.path, () => {});
  }
}

function discardUploads(req) {
  IMAGE_FIELDS.forEach((f) => (req.files?.[f] || []).forEach((file) => fs.unlink(file.path, () => {})));
}

const destroyImage = (publicId) =>
  publicId ? cloudinary.uploader.destroy(publicId).catch(() => {}) : Promise.resolve();

/**
 * @desc    List the dietician's client journeys
 * @route   GET /api/dietician/client-journeys
 */
exports.getClientJourneys = async (req, res) => {
  try {
    const journeys = await ClientJourney.find({ dieticianId: req.user._id })
      .sort({ createdAt: -1 })
      .lean();
    return res.status(200).json({ success: true, data: journeys });
  } catch (error) {
    console.error('getClientJourneys error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * @desc    Add a client journey (before + after required; review is an image
 *          OR text, optional)
 * @route   POST /api/dietician/client-journeys
 */
exports.addClientJourney = async (req, res) => {
  try {
    const dieticianId = req.user._id;
    const { title, reviewText, isActive } = req.body;

    if (!req.files?.beforeImage?.[0] || !req.files?.afterImage?.[0]) {
      discardUploads(req);
      return res
        .status(400)
        .json({ success: false, message: 'Both before and after images are required' });
    }
    const hasReviewImage = !!req.files?.reviewImage?.[0];
    const hasReviewText = !!(reviewText && reviewText.trim());
    if (hasReviewImage && hasReviewText) {
      discardUploads(req);
      return res
        .status(400)
        .json({ success: false, message: 'Add the review as an image or as text, not both' });
    }

    const before = await uploadField(req, 'beforeImage', dieticianId);
    const after = await uploadField(req, 'afterImage', dieticianId);
    const review = await uploadField(req, 'reviewImage', dieticianId);

    const journey = await ClientJourney.create({
      dieticianId,
      title: title || '',
      beforeImageUrl: before.url,
      beforeImagePublicId: before.publicId,
      afterImageUrl: after.url,
      afterImagePublicId: after.publicId,
      reviewType: review ? 'image' : hasReviewText ? 'text' : 'none',
      reviewImageUrl: review?.url || '',
      reviewImagePublicId: review?.publicId || '',
      reviewText: hasReviewText ? reviewText.trim() : '',
      isActive: isActive === undefined ? true : isTrue(isActive),
    });

    return res.status(201).json({ success: true, message: 'Client journey added', data: journey });
  } catch (error) {
    discardUploads(req);
    console.error('addClientJourney error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * @desc    Update a client journey. Any image can be replaced; sending
 *          reviewText switches the review to text (dropping a review image),
 *          sending a reviewImage switches it to an image (clearing the text),
 *          and removeReview=true clears the review.
 * @route   PUT /api/dietician/client-journeys/:journeyId
 */
exports.updateClientJourney = async (req, res) => {
  try {
    const dieticianId = req.user._id;
    const journey = await ClientJourney.findOne({ _id: req.params.journeyId, dieticianId });
    if (!journey) {
      discardUploads(req);
      return res.status(404).json({ success: false, message: 'Client journey not found' });
    }

    const { title, reviewText, isActive, removeReview } = req.body;
    if (title !== undefined) journey.title = title;
    if (isActive !== undefined) journey.isActive = isTrue(isActive);

    const before = await uploadField(req, 'beforeImage', dieticianId);
    if (before) {
      await destroyImage(journey.beforeImagePublicId);
      journey.beforeImageUrl = before.url;
      journey.beforeImagePublicId = before.publicId;
    }
    const after = await uploadField(req, 'afterImage', dieticianId);
    if (after) {
      await destroyImage(journey.afterImagePublicId);
      journey.afterImageUrl = after.url;
      journey.afterImagePublicId = after.publicId;
    }

    const clearReviewImage = async () => {
      await destroyImage(journey.reviewImagePublicId);
      journey.reviewImageUrl = '';
      journey.reviewImagePublicId = '';
    };

    const review = await uploadField(req, 'reviewImage', dieticianId);
    if (review) {
      await clearReviewImage();
      journey.reviewImageUrl = review.url;
      journey.reviewImagePublicId = review.publicId;
      journey.reviewText = '';
      journey.reviewType = 'image';
    } else if (reviewText !== undefined && reviewText.trim()) {
      await clearReviewImage();
      journey.reviewText = reviewText.trim();
      journey.reviewType = 'text';
    } else if (isTrue(removeReview) || reviewText !== undefined) {
      await clearReviewImage();
      journey.reviewText = '';
      journey.reviewType = 'none';
    }

    await journey.save();
    return res.status(200).json({ success: true, message: 'Client journey updated', data: journey });
  } catch (error) {
    discardUploads(req);
    console.error('updateClientJourney error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * @desc    Delete a client journey (and its Cloudinary images)
 * @route   DELETE /api/dietician/client-journeys/:journeyId
 */
exports.deleteClientJourney = async (req, res) => {
  try {
    const journey = await ClientJourney.findOneAndDelete({
      _id: req.params.journeyId,
      dieticianId: req.user._id,
    });
    if (!journey) {
      return res.status(404).json({ success: false, message: 'Client journey not found' });
    }
    await Promise.all([
      destroyImage(journey.beforeImagePublicId),
      destroyImage(journey.afterImagePublicId),
      destroyImage(journey.reviewImagePublicId),
    ]);
    return res.status(200).json({ success: true, message: 'Client journey deleted' });
  } catch (error) {
    console.error('deleteClientJourney error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * @desc    Active client journeys from the patient's assigned dietician
 *          (same assignment rule as getActiveQuotesForPatient)
 * @route   GET /api/patient/client-journeys
 */
exports.getActiveClientJourneysForPatient = async (req, res) => {
  try {
    const plan = await DietPlan.findOne({ patientId: req.user._id }).select('dieticianId').lean();
    const dieticianId = plan?.dieticianId || config.defaultDieticianId;
    if (!dieticianId) return res.status(200).json({ success: true, data: [] });

    const journeys = await ClientJourney.find({ dieticianId, isActive: true })
      .sort({ createdAt: -1 })
      .select('title beforeImageUrl afterImageUrl reviewType reviewImageUrl reviewText createdAt')
      .lean();
    return res.status(200).json({ success: true, data: journeys });
  } catch (error) {
    console.error('getActiveClientJourneysForPatient error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};
