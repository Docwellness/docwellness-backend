const mongoose = require('mongoose');

const chatSchema = new mongoose.Schema(
  {
    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    receiverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    message: {
      type: String,
      trim: true,
    },
    messageType: {
      type: String,
      enum: ['text', 'image', 'file', 'meal_log', 'diet_update', 'custom_food', 'doctor_note', 'confession_box', 'allergy_report', 'doctor_recommendation'],
      default: 'text',
    },
    attachment: {
      type: String,
    },
    description: {
      type: String,
      trim: true,
    },
    metadata: {
      mealLogId: { type: mongoose.Schema.Types.ObjectId, ref: 'MealLog' },
      action: { type: String, enum: ['added', 'updated', 'completed', 'note'] },
      itemName: String,
      calories: Number,
      servings: Number,
      servingTime: String,
      totalConsumed: Number,
      totalPlanned: Number,
      completionPercentage: Number,
      // Custom food fields
      customFoodRequestId: { type: mongoose.Schema.Types.ObjectId },
      foodName: String,
      description: String,
      quantityLabel: String,
      portion: Number,
      date: Date,
      imageUrl: String,
    },
    isRead: {
      type: Boolean,
      default: false,
    },
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Conversation',
      required: true,
    },
    replyTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Chat',
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

chatSchema.index({ conversationId: 1, createdAt: -1 });
chatSchema.index({ senderId: 1, receiverId: 1, createdAt: -1 });

module.exports = mongoose.model('Chat', chatSchema);
