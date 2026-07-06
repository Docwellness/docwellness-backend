/**
 * IdempotencyKey Model for REST API Deduplication
 * Stores results of idempotent operations
 */

const mongoose = require('mongoose');

const idempotencyKeySchema = new mongoose.Schema(
  {
    // Idempotency key from client
    key: {
      type: String,
      required: true,
      unique: true,
    },
    // User who made the request
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // Request fingerprint
    endpoint: {
      type: String,
      required: true,
    },
    method: {
      type: String,
      required: true,
    },
    // Stored response
    statusCode: {
      type: Number,
    },
    responseBody: {
      type: mongoose.Schema.Types.Mixed,
    },
    // Processing status
    status: {
      type: String,
      enum: ['pending', 'completed', 'failed'],
      default: 'pending',
    },
    // Lock for concurrent requests
    lockedAt: {
      type: Date,
    },
    completedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

// TTL index - keys expire after 24 hours
idempotencyKeySchema.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

// Compound index for lookup
idempotencyKeySchema.index({ key: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('IdempotencyKey', idempotencyKeySchema);
