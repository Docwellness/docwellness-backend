const mongoose = require('mongoose');

const socialMediaPostSchema = new mongoose.Schema(
  {
    dieticianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    platform: {
      type: String,
      enum: ['youtube', 'instagram'],
      required: true,
    },
    url: {
      type: String,
      required: true,
    },
    // Auto-derived from the YouTube URL when omitted (see socialMediaController)
    // - Instagram has no equivalent public thumbnail API, so it's required
    // there.
    thumbnailUrl: {
      type: String,
      default: '',
    },
    cloudinaryPublicId: {
      type: String,
      default: '',
    },
    caption: {
      type: String,
      default: '',
      trim: true,
    },
    // Lower sorts first - see socialMediaController.reorderSocialPosts.
    order: {
      type: Number,
      default: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('SocialMediaPost', socialMediaPostSchema);
