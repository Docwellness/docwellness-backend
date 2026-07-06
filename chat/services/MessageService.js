/**
 * MessageService - Core Message Operations
 * Send, dedupe, persist, and fanout messages
 */

const mongoose = require('mongoose');
const { MessageV1, ConversationV1 } = require('../models');
const Chat = require('../../models/Chat');
const Conversation = require('../../models/Conversation');
const SequenceService = require('./SequenceService');
const LinkPreviewService = require('./LinkPreviewService');
const ChatLogger = require('./ChatLogger');

const { EVENTS } = ChatLogger;

class MessageService {
  /**
   * Send a message with deduplication and sequencing
   * @param {object} params - Message parameters
   * @param {object} logContext - Logging context
   * @returns {Promise<object>} Created message with ack data
   */
  static async sendMessage(params, logContext = {}) {
    const startTime = Date.now();
    const {
      conversationId,
      senderId,
      receiverId,
      clientMessageId,
      type = 'text',
      content = '',
      attachment = null,
      replyTo = null,
      mealLogData = null,
      waterIntakeData = null,
      dietPlanData = null,
      customFoodData = null,
      confessionData = null,
      allergyReportData = null,
      recommendationData = null,
    } = params;

    // Log send attempt
    ChatLogger.info(EVENTS.MSG_SEND, {
      ...logContext,
      conversation_id: conversationId,
      user_id: senderId,
      client_message_id: clientMessageId,
      type,
    });

    // Check for duplicate using unique index
    const existingMessage = await MessageV1.findOne({
      conversationId,
      senderId,
      clientMessageId,
    });

    if (existingMessage) {
      ChatLogger.info(EVENTS.MSG_DEDUP_HIT, {
        ...logContext,
        conversation_id: conversationId,
        user_id: senderId,
        client_message_id: clientMessageId,
        message_id: existingMessage._id,
        server_seq: existingMessage.serverSeq,
      });

      return {
        dedup: true,
        message: existingMessage,
        ack: {
          message_id: existingMessage._id,
          server_seq: existingMessage.serverSeq,
          created_at: existingMessage.createdAt,
        },
      };
    }

    // Allocate server sequence
    const serverSeq = await SequenceService.getNextSeq(conversationId, logContext);

    // Extract and fetch link preview if text contains URLs
    let linkPreview = null;
    if (type === 'text' && content) {
      const urls = LinkPreviewService.extractUrls(content);
      if (urls.length > 0) {
        // Fetch first URL preview (non-blocking, with timeout)
        linkPreview = await Promise.race([
          LinkPreviewService.getPreview(urls[0], logContext),
          new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
        ]).catch(() => null);
      }
    }

    // Create message
    const messageData = {
      conversationId: new mongoose.Types.ObjectId(conversationId),
      senderId: new mongoose.Types.ObjectId(senderId),
      receiverId: new mongoose.Types.ObjectId(receiverId),
      clientMessageId,
      serverSeq,
      type,
      content,
      status: 'sent',
    };

    if (attachment) {
      messageData.attachment = attachment;
    }

    if (linkPreview && !linkPreview.error) {
      messageData.linkPreview = {
        url: linkPreview.url,
        title: linkPreview.title,
        description: linkPreview.description,
        imageUrl: linkPreview.imageUrl,
        siteName: linkPreview.siteName,
        fetchedAt: new Date(),
      };
    }

    if (replyTo) {
      messageData.replyTo = replyTo;
    }

    if (mealLogData) {
      messageData.mealLogData = mealLogData;
    }

    if (waterIntakeData) {
      messageData.waterIntakeData = waterIntakeData;
    }

    if (dietPlanData) {
      messageData.dietPlanData = dietPlanData;
    }

    if (customFoodData) {
      messageData.customFoodData = customFoodData;
    }

    if (confessionData) {
      messageData.confessionData = confessionData;
    }

    if (allergyReportData) {
      messageData.allergyReportData = allergyReportData;
    }

    if (recommendationData) {
      messageData.recommendationData = recommendationData;
    }

    // Try to insert with unique index (handles race conditions)
    let message;
    try {
      message = await MessageV1.create(messageData);
    } catch (error) {
      // Check if duplicate key error
      if (error.code === 11000) {
        const existingMsg = await MessageV1.findOne({
          conversationId,
          senderId,
          clientMessageId,
        });

        if (existingMsg) {
          ChatLogger.info(EVENTS.MSG_DEDUP_HIT, {
            ...logContext,
            conversation_id: conversationId,
            user_id: senderId,
            client_message_id: clientMessageId,
            message_id: existingMsg._id,
            reason: 'race_condition',
          });

          return {
            dedup: true,
            message: existingMsg,
            ack: {
              message_id: existingMsg._id,
              server_seq: existingMsg.serverSeq,
              created_at: existingMsg.createdAt,
            },
          };
        }
      }
      throw error;
    }

    ChatLogger.timed(EVENTS.MSG_PERSISTED, startTime, {
      ...logContext,
      conversation_id: conversationId,
      user_id: senderId,
      message_id: message._id,
      server_seq: serverSeq,
      client_message_id: clientMessageId,
    });

    // ====== DUAL-WRITE to old Chat collection for backward compatibility ======
    try {
      // Find or create conversation in old collection
      let oldConversation = await Conversation.findOne({
        $and: [
          { 'participants.userId': new mongoose.Types.ObjectId(senderId) },
          { 'participants.userId': new mongoose.Types.ObjectId(receiverId) },
        ],
      });

      if (!oldConversation) {
        oldConversation = await Conversation.create({
          participants: [
            { userId: new mongoose.Types.ObjectId(senderId) },
            { userId: new mongoose.Types.ObjectId(receiverId) },
          ],
        });
      }

      // Create message in old Chat collection
      await Chat.create({
        conversationId: oldConversation._id,
        senderId: new mongoose.Types.ObjectId(senderId),
        receiverId: new mongoose.Types.ObjectId(receiverId),
        message: content || '',
        messageType: type,
        attachment: attachment?.url || null,
        replyTo: replyTo?.messageId || null,
      });

      // Update old conversation
      oldConversation.lastMessage = type === 'text' ? content?.substring(0, 100) : `[${type}]`;
      oldConversation.lastMessageAt = new Date();
      oldConversation.lastMessageSender = new mongoose.Types.ObjectId(senderId);
      oldConversation.participants.forEach((p) => {
        if (p.userId.toString() !== senderId.toString()) {
          p.unreadCount = (p.unreadCount || 0) + 1;
        }
      });
      await oldConversation.save();
    } catch (dualWriteError) {
      // Log but don't fail - old collection is for backward compatibility only
      console.error('Dual-write to old Chat collection failed:', dualWriteError.message);
    }
    // ====== END DUAL-WRITE ======

    // Update conversation
    await ConversationV1.findByIdAndUpdate(
      conversationId,
      {
        lastMessage: {
          messageId: message._id,
          content: type === 'text' ? content.substring(0, 100) : `[${type}]`,
          type,
          senderId,
          createdAt: message.createdAt,
        },
        lastMessageAt: message.createdAt,
        serverSeq,
        $inc: { 'participants.$[other].unreadCount': 1 },
      },
      {
        arrayFilters: [{ 'other.userId': { $ne: new mongoose.Types.ObjectId(senderId) } }],
      }
    );

    return {
      dedup: false,
      message,
      ack: {
        message_id: message._id,
        server_seq: serverSeq,
        created_at: message.createdAt,
      },
    };
  }

  /**
   * Get messages for a conversation with pagination
   * @param {object} params - Query parameters
   * @returns {Promise<object>} Messages and metadata
   */
  static async getMessages(params) {
    const { conversationId, limit = 50, beforeSeq = null, afterSeq = null } = params;

    const query = {
      conversationId: new mongoose.Types.ObjectId(conversationId),
      deletedAt: null,
    };

    // Pagination by sequence
    if (beforeSeq !== null) {
      query.serverSeq = { $lt: beforeSeq };
    } else if (afterSeq !== null) {
      query.serverSeq = { $gt: afterSeq };
    }

    const sort =
      afterSeq !== null
        ? { serverSeq: 1 } // Oldest first for sync
        : { serverSeq: -1 }; // Newest first for history

    const messages = await MessageV1.find(query)
      .sort(sort)
      .limit(limit + 1)
      .lean();

    const hasMore = messages.length > limit;
    if (hasMore) {
      messages.pop();
    }

    // For afterSeq queries, reverse to chronological order
    if (afterSeq !== null) {
      // Already in correct order
    } else {
      messages.reverse();
    }

    return {
      messages,
      hasMore,
      nextCursor:
        hasMore && messages.length > 0
          ? afterSeq !== null
            ? messages[messages.length - 1].serverSeq
            : messages[0].serverSeq
          : null,
    };
  }

  /**
   * Mark message as delivered
   * @param {string} messageId - Message ID
   * @param {object} logContext - Logging context
   */
  static async markDelivered(messageId, logContext = {}) {
    const message = await MessageV1.findByIdAndUpdate(
      messageId,
      {
        status: 'delivered',
        deliveredAt: new Date(),
      },
      { new: true }
    );

    if (message) {
      ChatLogger.info(EVENTS.MSG_DELIVERED, {
        ...logContext,
        message_id: messageId,
        conversation_id: message.conversationId,
      });
    }

    return message;
  }

  /**
   * Mark conversation as read up to a sequence
   * @param {string} conversationId - Conversation ID
   * @param {string} userId - User ID
   * @param {number} lastReadSeq - Last read sequence
   * @param {object} logContext - Logging context
   */
  static async markRead(conversationId, userId, lastReadSeq, logContext = {}) {
    const startTime = Date.now();

    // Update messages to read status
    await MessageV1.updateMany(
      {
        conversationId: new mongoose.Types.ObjectId(conversationId),
        receiverId: new mongoose.Types.ObjectId(userId),
        serverSeq: { $lte: lastReadSeq },
        status: { $ne: 'read' },
      },
      {
        status: 'read',
        readAt: new Date(),
      }
    );

    // Update participant's lastReadSeq and unreadCount
    await ConversationV1.updateOne(
      { _id: conversationId, 'participants.userId': new mongoose.Types.ObjectId(userId) },
      {
        $set: {
          'participants.$.lastReadSeq': lastReadSeq,
          'participants.$.unreadCount': 0,
        },
      }
    );

    ChatLogger.timed(EVENTS.CONV_READ, startTime, {
      ...logContext,
      conversation_id: conversationId,
      user_id: userId,
      last_read_seq: lastReadSeq,
    });
  }

  /**
   * Update meal log message in-place
   * @param {string} mealLogId - Meal log ID
   * @param {object} snapshot - Updated snapshot
   * @param {number} version - New version
   * @param {object} logContext - Logging context
   * @returns {Promise<object|null>} Updated message or null
   */
  static async updateMealLogMessage(mealLogId, snapshot, version, logContext = {}) {
    const message = await MessageV1.findOneAndUpdate(
      {
        type: 'meal_log',
        'mealLogData.mealLogId': new mongoose.Types.ObjectId(mealLogId),
        'mealLogData.mealLogVersion': { $lt: version },
      },
      {
        $set: {
          'mealLogData.snapshot': snapshot,
          'mealLogData.mealLogVersion': version,
          'mealLogData.updatedAt': new Date(),
        },
      },
      { new: true }
    );

    if (message) {
      ChatLogger.info(EVENTS.MSG_MEAL_LOG_UPDATED, {
        ...logContext,
        message_id: message._id,
        meal_log_id: mealLogId,
        meal_log_version: version,
        conversation_id: message.conversationId,
      });
    }

    return message;
  }
}

module.exports = MessageService;
