/**
 * ProcessedEvent Model for Webhook/Event Deduplication
 * Ensures idempotent processing of meal log events
 */

const mongoose = require('mongoose');

const processedEventSchema = new mongoose.Schema(
  {
    // Unique event ID from source
    eventId: {
      type: String,
      required: true,
      unique: true,
    },
    eventType: {
      type: String,
      required: true,
      enum: ['meal_log.created', 'meal_log.updated', 'meal_log.deleted', 'meal_log.completed'],
    },
    // Source entity ID
    entityId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    // Version at time of processing
    entityVersion: {
      type: Number,
      required: true,
    },
    // Conversation affected
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ConversationV1',
    },
    // Message created/updated
    messageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MessageV1',
    },
    // Actor
    actorUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    // Processing metadata
    processedAt: {
      type: Date,
      default: Date.now,
    },
    status: {
      type: String,
      enum: ['processed', 'skipped', 'failed'],
      default: 'processed',
    },
    error: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
);

// TTL index - events expire after 30 days
processedEventSchema.index({ processedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

// Index for looking up by entity
processedEventSchema.index({ entityId: 1, entityVersion: 1 });

module.exports = mongoose.model('ProcessedEvent', processedEventSchema);
