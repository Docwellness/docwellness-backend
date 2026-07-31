const Review = require('../../models/Review');
const { resolvePatientDieticianId } = require('../../utils/resolvePatientDieticianId');

/**
 * @desc    Get all reviews for the dietician (management view)
 * @route   GET /api/dietician/reviews
 * @access  Dietician only
 */
exports.getReviews = async (req, res) => {
  try {
    const reviews = await Review.find({ dieticianId: req.user._id }).sort({ order: 1 }).lean();
    return res.status(200).json({ success: true, data: reviews });
  } catch (error) {
    console.error('getReviews error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * @desc    Persist a new display order (drag-reorder on the dietician app)
 * @route   PUT /api/dietician/reviews/reorder
 * @body    { orderedIds: string[] }
 * @access  Dietician only
 */
exports.reorderReviews = async (req, res) => {
  try {
    const dieticianId = req.user._id;
    const { orderedIds } = req.body;

    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      return res.status(400).json({ success: false, message: 'orderedIds must be a non-empty array' });
    }

    await Promise.all(
      orderedIds.map((id, index) => Review.updateOne({ _id: id, dieticianId }, { order: index }))
    );

    return res.status(200).json({ success: true, message: 'Order updated' });
  } catch (error) {
    console.error('reorderReviews error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * @desc    Delete a review (e.g. one that's inappropriate)
 * @route   DELETE /api/dietician/reviews/:id
 * @access  Dietician only
 */
exports.deleteReview = async (req, res) => {
  try {
    const review = await Review.findOneAndDelete({ _id: req.params.id, dieticianId: req.user._id });
    if (!review) {
      return res.status(404).json({ success: false, message: 'Review not found' });
    }
    return res.status(200).json({ success: true, message: 'Review deleted' });
  } catch (error) {
    console.error('deleteReview error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * @desc    Get the assigned dietician's reviews, plus this patient's own
 *          review (if any) so the app can show "Edit your review" instead
 *          of "Write a review".
 * @route   GET /api/patient/reviews
 * @access  Patient only
 */
exports.getReviewsForPatient = async (req, res) => {
  try {
    const dieticianId = await resolvePatientDieticianId(req.user._id);
    if (!dieticianId) {
      return res.status(200).json({ success: true, data: { reviews: [], averageRating: 0, myReview: null } });
    }

    const reviews = await Review.find({ dieticianId }).sort({ order: 1 }).lean();
    const averageRating = reviews.length
      ? reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length
      : 0;
    const myReview = reviews.find((r) => String(r.patientId) === String(req.user._id)) || null;

    return res.status(200).json({
      success: true,
      data: { reviews, averageRating, myReview },
    });
  } catch (error) {
    console.error('getReviewsForPatient error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * @desc    Submit (or update) this patient's review of their assigned dietician
 * @route   POST /api/patient/reviews
 * @body    { rating: 1-5, text?: string }
 * @access  Patient only
 */
exports.addReview = async (req, res) => {
  try {
    const patientId = req.user._id;
    const { rating, text } = req.body;

    const numericRating = Number(rating);
    if (!numericRating || numericRating < 1 || numericRating > 5) {
      return res.status(400).json({ success: false, message: 'rating must be between 1 and 5' });
    }

    const dieticianId = await resolvePatientDieticianId(patientId);
    if (!dieticianId) {
      return res.status(404).json({ success: false, message: 'No assigned dietician found' });
    }

    const patientName = req.user.profile?.fullName || 'Docwellness patient';

    // Upsert so re-submitting edits the existing review in place rather
    // than creating a duplicate (see the unique dieticianId+patientId
    // index on the model).
    const review = await Review.findOneAndUpdate(
      { dieticianId, patientId },
      {
        $set: { rating: numericRating, text: text || '', patientName },
        $setOnInsert: { order: Date.now() },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    return res.status(200).json({ success: true, message: 'Review saved', data: review });
  } catch (error) {
    console.error('addReview error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};
