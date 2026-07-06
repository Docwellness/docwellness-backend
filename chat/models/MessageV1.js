/**
 * Enhanced Message Model for WhatsApp-like Chat
 * Supports multiple message types, dedup, and server sequencing
 */

const mongoose = require('mongoose');

const messageV1Schema = new mongoose.Schema(
  {
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ConversationV1',
      required: true,
      index: true,
    },
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
    // Client-generated unique ID for deduplication
    clientMessageId: {
      type: String,
      required: true,
    },
    // Server-assigned monotonically increasing sequence per conversation
    serverSeq: {
      type: Number,
      required: true,
    },
    // Message type
    type: {
      type: String,
      enum: [
        'text',
        'image',
        'file',
        'audio',
        'link',
        'system',
        'meal_log',
        'water_intake',
        'diet_plan',
        'custom_food',
        'doctor_note',
        'confession_box',
        'allergy_report',
        'doctor_recommendation',
      ],
      default: 'text',
    },
    // Text content
    content: {
      type: String,
      trim: true,
      default: '',
    },
    // Attachment for media types
    attachment: {
      url: { type: String },
      mimeType: { type: String },
      fileName: { type: String },
      fileSize: { type: Number },
      thumbnailUrl: { type: String },
      duration: { type: Number }, // for audio
      width: { type: Number },
      height: { type: Number },
    },
    // Link preview data
    linkPreview: {
      url: { type: String },
      title: { type: String },
      description: { type: String },
      imageUrl: { type: String },
      siteName: { type: String },
      fetchedAt: { type: Date },
    },
    // Meal log metadata for type='meal_log'
    mealLogData: {
      mealLogId: { type: mongoose.Schema.Types.ObjectId, ref: 'MealLog' },
      mealLogVersion: { type: Number, default: 1 },
      action: { type: String, enum: ['added', 'updated', 'completed', 'deleted', 'note'] },
      snapshot: { type: mongoose.Schema.Types.Mixed },
      updatedAt: { type: Date },
    },
    // Water intake metadata for type='water_intake'
    waterIntakeData: {
      amount: { type: Number }, // in ml
      timestamp: { type: Date },
      source: { type: String }, // 'manual' or 'auto'
    },
    // Diet plan metadata for type='diet_plan'
    dietPlanData: {
      dietPlanId: { type: mongoose.Schema.Types.ObjectId, ref: 'DietPlan' },
      dayName: { type: String },
      weekDay: { type: String },
      weekNumber: { type: Number },
      meals: [{ type: mongoose.Schema.Types.Mixed }],
      totalCalories: { type: Number },
      totalProtein: { type: Number },
      totalCarbs: { type: Number },
      totalFat: { type: Number },
    },
    // Custom food metadata for type='custom_food'
    customFoodData: {
      foodName: { type: String },
      description: { type: String },
      image: { type: String },
      calories: { type: Number },
      protein: { type: Number },
      carbs: { type: Number },
      fat: { type: Number },
      status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
      reviewedAt: { type: Date },
      reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      customFoodRequestId: { type: mongoose.Schema.Types.ObjectId, ref: 'CustomFoodRequest' },
    },
    // Doctor note metadata for type='doctor_note'
    doctorNoteData: {
      noteDate: { type: Date },
      noteContent: { type: String, trim: true },
    },
    // Confession box metadata for type='confession_box'
    confessionData: {
      confessionText: { type: String, trim: true },
    },
    // Allergy report metadata for type='allergy_report'
    allergyReportData: {
      allergyText: { type: String, trim: true },
    },
    // Doctor recommendation metadata for type='doctor_recommendation'
    recommendationData: {
      recommendationText: { type: String, trim: true },
      category: { type: String, enum: ['diet', 'exercise', 'lifestyle', 'general'], default: 'general' },
    },
    // Reply reference
    replyTo: {
      messageId: { type: mongoose.Schema.Types.ObjectId, ref: 'MessageV1' },
      content: { type: String },
      senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      type: { type: String },
    },
    // Delivery tracking
    status: {
      type: String,
      enum: ['sent', 'delivered', 'read'],
      default: 'sent',
    },
    deliveredAt: { type: Date },
    readAt: { type: Date },
    // Soft delete
    deletedAt: { type: Date, default: null },
    deletedFor: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  },
  {
    timestamps: true,
  }
);

// Compound unique index for deduplication
messageV1Schema.index({ conversationId: 1, senderId: 1, clientMessageId: 1 }, { unique: true });

// Index for fetching messages by seq
messageV1Schema.index({ conversationId: 1, serverSeq: 1 });
messageV1Schema.index({ conversationId: 1, createdAt: -1 });

// Index for meal log lookups
messageV1Schema.index({ 'mealLogData.mealLogId': 1, type: 1 });

module.exports = mongoose.model('MessageV1', messageV1Schema);
