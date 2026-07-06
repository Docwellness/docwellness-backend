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
  },
  {
    timestamps: true,
  }
);

conversationSchema.index({ 'participants.userId': 1 });

module.exports = mongoose.model('Conversation', conversationSchema);