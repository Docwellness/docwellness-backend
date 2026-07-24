const mongoose = require('mongoose');

const conversationSchema = new mongoose.Schema(
  {
    participants: [
      {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        unreadCount: { type: Number, default: 0 },
      },
    ],
    lastMessage: {
      type: String,
      trim: true,
    },
    lastMessageAt: {
      type: Date,
    },
    lastMessageSender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    // Monotonically increasing per-conversation sequence, mirroring
    // ConversationV1/MessageV1's serverSeq in the v1 module (see
    // AI_EXECUTION_PLAN.md Phase 4, P4-03) - tracks the last value handed
    // out via getNextSeq below, so each Chat message in this conversation
    // gets a unique, gap-free (per successful send), reconnect-sync-able
    // ordering independent of createdAt (which can collide/reorder under
    // concurrent sends or clock skew).
    nextSeq: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

conversationSchema.index({ 'participants.userId': 1 });

// Atomically allocates and returns the next sequence number for this
// conversation - findByIdAndUpdate's $inc is a single atomic document
// operation, so two concurrent sends can never be handed the same value.
conversationSchema.statics.getNextSeq = async function (conversationId) {
  const result = await this.findByIdAndUpdate(
    conversationId,
    { $inc: { nextSeq: 1 } },
    { new: true }
  );
  return result ? result.nextSeq : null;
};

module.exports = mongoose.model('Conversation', conversationSchema);