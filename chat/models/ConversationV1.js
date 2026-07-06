/**
 * Enhanced Conversation Model for WhatsApp-like Chat
 * Supports 1:1 conversations with participant metadata
 */

const mongoose = require('mongoose');

const participantSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    unreadCount: {
      type: Number,
      default: 0,
    },
    lastReadSeq: {
      type: Number,
      default: 0,
    },
    lastDeliveredSeq: {
      type: Number,
      default: 0,
    },
    joinedAt: {
      type: Date,
      default: Date.now,
    },
    mutedUntil: {
      type: Date,
      default: null,
    },
  },
  { _id: false }
);

const conversationV1Schema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['direct'],
      default: 'direct',
    },
    participants: [participantSchema],
    lastMessage: {
      messageId: { type: mongoose.Schema.Types.ObjectId, ref: 'MessageV1' },
      content: { type: String, trim: true },
      type: { type: String, default: 'text' },
      senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      createdAt: { type: Date },
    },
    lastMessageAt: {
      type: Date,
      index: true,
    },
    serverSeq: {
      type: Number,
      default: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for efficient querying
conversationV1Schema.index({ 'participants.userId': 1, lastMessageAt: -1 });
conversationV1Schema.index(
  { 'participants.userId': 1, 'participants.userId': 1 },
  { unique: true, sparse: true }
);

// Find or create direct conversation between two users
conversationV1Schema.statics.findOrCreateDirect = async function (userId1, userId2) {
  // Sort to ensure consistent ordering
  const sortedIds = [userId1.toString(), userId2.toString()].sort();

  let conversation = await this.findOne({
    type: 'direct',
    'participants.userId': { $all: sortedIds.map((id) => new mongoose.Types.ObjectId(id)) },
    $expr: { $eq: [{ $size: '$participants' }, 2] },
  });

  if (!conversation) {
    conversation = await this.create({
      type: 'direct',
      participants: [{ userId: sortedIds[0] }, { userId: sortedIds[1] }],
    });
  }

  return conversation;
};

// Get participant info for a user
conversationV1Schema.methods.getParticipant = function (userId) {
  return this.participants.find((p) => p.userId.toString() === userId.toString());
};

// Get other participant in direct conversation
conversationV1Schema.methods.getOtherParticipant = function (userId) {
  return this.participants.find((p) => p.userId.toString() !== userId.toString());
};

module.exports = mongoose.model('ConversationV1', conversationV1Schema);
