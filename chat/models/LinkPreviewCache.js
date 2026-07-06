/**
 * LinkPreviewCache Model for Open Graph Data Caching
 * TTL-based cache for link preview metadata
 */

const mongoose = require('mongoose');

const linkPreviewCacheSchema = new mongoose.Schema(
  {
    // URL as the key (normalized)
    url: {
      type: String,
      required: true,
      unique: true,
    },
    // URL hash for faster lookups
    urlHash: {
      type: String,
      required: true,
      index: true,
    },
    // Open Graph data
    title: {
      type: String,
      trim: true,
      maxlength: 500,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 1000,
    },
    imageUrl: {
      type: String,
    },
    siteName: {
      type: String,
      trim: true,
      maxlength: 200,
    },
    faviconUrl: {
      type: String,
    },
    // Fetch metadata
    fetchedAt: {
      type: Date,
      default: Date.now,
    },
    fetchStatus: {
      type: String,
      enum: ['success', 'failed', 'pending'],
      default: 'pending',
    },
    fetchError: {
      type: String,
    },
    // Cache control
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    },
  },
  {
    timestamps: true,
  }
);

// TTL index - cache entries expire automatically
linkPreviewCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('LinkPreviewCache', linkPreviewCacheSchema);
