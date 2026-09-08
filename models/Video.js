const mongoose = require('mongoose');

const videoSchema = new mongoose.Schema(
  {
    dieticianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    title: {
      type: String,
      default: '',
    },
    source: {
      type: String,
      enum: ['YouTube', 'Device Storage'],
      required: true,
    },
    youtubeUrl: {
      type: String,
      default: '',
    },
    thumbnailUrl: {
      type: String,
      default: '',
    },
    // Short (~6s), muted, portrait MP4 used for the inline autoplay preview
    // in the user app's "Videos for you" rail - played natively via
    // video_player, far lighter than embedding the YouTube webview.
    // Populated by scripts/generate-video-previews.js; empty = rail just
    // shows the static thumbnail for this one.
    previewClipUrl: {
      type: String,
      default: '',
    },
    bannerImage: {
      type: String,
      default: '',
    },
    videoFile: {
      type: String,
      default: '',
    },
    visibleToUser: {
      type: Boolean,
      default: false,
    },
    text: {
      type: String,
      default: '',
      trim: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Video', videoSchema);
