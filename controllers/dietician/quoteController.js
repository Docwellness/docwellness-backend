const Quote = require('../../models/Quote');
const cloudinary = require('../../config/cloudinary');
const { cloudinaryUserFolder } = require('../../utils/cloudinaryFolder');
const fs = require('fs');
const { Notification, User, DietPlan } = require('../../models');
const config = require('../../config/environment');
const { getChatIO } = require('../../chat');
const { sendPushToTokens } = require('../../utils/push');

/**
 * Notifies every patient who can currently see this dietician's quotes (same
 * assignment rule as getActiveQuotesForPatient below: DietPlan.dieticianId,
 * falling back to patients with no DietPlan at all when this is the default
 * dietician) that a new quote is live. In-app Notification + socket push are
 * awaited so a failure here surfaces to the caller's own catch; the real FCM
 * send is fire-and-forget like every other push in this codebase - it must
 * never fail or delay the caller.
 */
async function notifyPatientsOfQuote(dieticianId, quote) {
  const assignedPatientIds = await DietPlan.find({ dieticianId }).distinct('patientId');
  const patientIds = [...assignedPatientIds];

  if (config.defaultDieticianId && String(dieticianId) === String(config.defaultDieticianId)) {
    const anyAssignedPatientIds = await DietPlan.distinct('patientId');
    const unassignedPatientIds = await User.find({
      role: 'patient',
      _id: { $nin: anyAssignedPatientIds },
    }).distinct('_id');
    patientIds.push(...unassignedPatientIds);
  }

  if (patientIds.length === 0) return;

  const title = 'New quote from your dietician';
  const message = quote.text || "Tap to see today's quote";

  const notifications = await Notification.insertMany(
    patientIds.map((patientId) => ({
      userId: patientId,
      title,
      message,
      type: 'quote',
      referenceId: quote._id,
      referenceModel: 'Quote',
    }))
  );

  const ioRef = getChatIO();
  if (ioRef) {
    notifications.forEach((notif) => {
      ioRef.to(`user:${notif.userId}`).emit('notification.new', {
        id: notif._id,
        title: notif.title,
        message: notif.message,
        type: notif.type,
        referenceId: notif.referenceId?.toString(),
        createdAt: notif.createdAt,
      });
    });
  }

  const patients = await User.find({ _id: { $in: patientIds } }).select('deviceTokens').lean();
  const tokenToUserId = new Map();
  const tokens = [];
  patients.forEach((patient) => {
    (patient.deviceTokens || []).forEach((t) => {
      tokens.push(t.token);
      tokenToUserId.set(t.token, patient._id);
    });
  });

  sendPushToTokens(
    tokens,
    { title, body: message, data: { deepLink: 'docwellness://quotes' } },
    (deadToken) => {
      const userId = tokenToUserId.get(deadToken);
      if (userId) {
        User.updateOne({ _id: userId }, { $pull: { deviceTokens: { token: deadToken } } }).catch(() => {});
      }
    }
  ).catch((err) => console.error('[notifyPatientsOfQuote] push failed (non-fatal):', err.message));
}

/**
 * @desc    Add a new quote (image uploaded to Cloudinary)
 * @route   POST /api/dietician/quotes
 * @access  Dietician only
 */
exports.addQuote = async (req, res) => {
  try {
    const dieticianId = req.user._id;
    const { isActive, text } = req.body;

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Image is required' });
    }

    // Upload to Cloudinary
    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: cloudinaryUserFolder(dieticianId, 'quotes'),
      transformation: [{ quality: 'auto', fetch_format: 'auto' }],
    });

    // Remove local temp file
    fs.unlink(req.file.path, () => {});

    const quote = await Quote.create({
      dieticianId,
      imageUrl: result.secure_url,
      cloudinaryPublicId: result.public_id,
      text: text || '',
      isActive: isActive === true || isActive === 'true',
    });

    if (quote.isActive) {
      notifyPatientsOfQuote(dieticianId, quote).catch((err) =>
        console.error('notifyPatientsOfQuote error:', err)
      );
    }

    return res.status(201).json({
      success: true,
      message: 'Quote added successfully',
      data: quote,
    });
  } catch (error) {
    console.error('addQuote error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * @desc    Get all quotes for the dietician
 * @route   GET /api/dietician/quotes
 * @access  Dietician only
 */
exports.getQuotes = async (req, res) => {
  try {
    const quotes = await Quote.find({ dieticianId: req.user._id }).sort({ createdAt: -1 }).lean();
    return res.status(200).json({
      success: true,
      data: quotes,
    });
  } catch (error) {
    console.error('getQuotes error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * @desc    Update an existing quote (replace image, toggle active)
 * @route   PUT /api/dietician/quotes/:quoteId
 * @access  Dietician only
 */
exports.updateQuote = async (req, res) => {
  try {
    const { quoteId } = req.params;
    const dieticianId = req.user._id;
    const { isActive } = req.body;

    const quote = await Quote.findOne({ _id: quoteId, dieticianId });
    if (!quote) {
      return res.status(404).json({ success: false, message: 'Quote not found' });
    }
    const wasActive = quote.isActive;

    // If new image uploaded, replace in Cloudinary
    if (req.file) {
      // Delete old image from Cloudinary
      if (quote.cloudinaryPublicId) {
        await cloudinary.uploader.destroy(quote.cloudinaryPublicId).catch(() => {});
      }

      const result = await cloudinary.uploader.upload(req.file.path, {
        folder: cloudinaryUserFolder(dieticianId, 'quotes'),
        transformation: [{ quality: 'auto', fetch_format: 'auto' }],
      });

      fs.unlink(req.file.path, () => {});

      quote.imageUrl = result.secure_url;
      quote.cloudinaryPublicId = result.public_id;
    }

    if (req.body.text !== undefined) {
      quote.text = req.body.text;
    }

    if (isActive !== undefined) {
      quote.isActive = isActive === true || isActive === 'true';
    }

    await quote.save();

    if (!wasActive && quote.isActive) {
      notifyPatientsOfQuote(dieticianId, quote).catch((err) =>
        console.error('notifyPatientsOfQuote error:', err)
      );
    }

    return res.status(200).json({
      success: true,
      message: 'Quote updated successfully',
      data: quote,
    });
  } catch (error) {
    console.error('updateQuote error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * @desc    Delete a specific quote
 * @route   DELETE /api/dietician/quotes/:quoteId
 * @access  Dietician only
 */
exports.deleteQuote = async (req, res) => {
  try {
    const { quoteId } = req.params;
    const quote = await Quote.findOneAndDelete({
      _id: quoteId,
      dieticianId: req.user._id,
    });

    if (!quote) {
      return res.status(404).json({ success: false, message: 'Quote not found' });
    }

    // Delete from Cloudinary
    if (quote.cloudinaryPublicId) {
      await cloudinary.uploader.destroy(quote.cloudinaryPublicId).catch(() => {});
    }

    return res.status(200).json({
      success: true,
      message: 'Quote deleted successfully',
    });
  } catch (error) {
    console.error('deleteQuote error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * @desc    Get active quotes for patient (visible ones)
 * @route   GET /api/patient/quotes
 * @access  Patient only
 */
exports.getActiveQuotesForPatient = async (req, res) => {
  try {
    const patientId = req.user._id;

    // Find the dietician assigned to this patient via DietPlan, fallback to default dietician
    let dieticianId;
    const plan = await DietPlan.findOne({ patientId }).select('dieticianId').lean();
    if (plan && plan.dieticianId) {
      dieticianId = plan.dieticianId;
    } else if (config.defaultDieticianId) {
      dieticianId = config.defaultDieticianId;
    } else {
      return res.status(200).json({ success: true, data: [] });
    }

    const quotes = await Quote.find({ dieticianId, isActive: true }).sort({ createdAt: -1 }).lean();

    return res.status(200).json({
      success: true,
      data: quotes,
    });
  } catch (error) {
    console.error('getActiveQuotesForPatient error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};
