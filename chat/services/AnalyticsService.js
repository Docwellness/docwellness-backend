/**
 * AnalyticsService - Basic Chat Analytics
 * MongoDB aggregation-based analytics
 */

const mongoose = require('mongoose');
const { MessageV1, ConversationV1 } = require('../models');

class AnalyticsService {
  /**
   * Get message count by type for a conversation
   * @param {string} conversationId - Conversation ID
   * @returns {Promise<object>} Message counts by type
   */
  static async getMessageCounts(conversationId) {
    const result = await MessageV1.aggregate([
      {
        $match: {
          conversationId: new mongoose.Types.ObjectId(conversationId),
          deletedAt: null,
        },
      },
      {
        $group: {
          _id: '$type',
          count: { $sum: 1 },
        },
      },
    ]);

    return result.reduce((acc, item) => {
      acc[item._id] = item.count;
      return acc;
    }, {});
  }

  /**
   * Get conversation statistics for a user
   * @param {string} userId - User ID
   * @returns {Promise<object>} Conversation stats
   */
  static async getConversationStats(userId) {
    const conversations = await ConversationV1.find({
      'participants.userId': new mongoose.Types.ObjectId(userId),
    }).lean();

    let totalUnread = 0;
    let activeConversations = 0;

    conversations.forEach((conv) => {
      const participant = conv.participants.find((p) => p.userId.toString() === userId);
      if (participant) {
        totalUnread += participant.unreadCount || 0;
      }
      if (conv.isActive) {
        activeConversations++;
      }
    });

    return {
      totalConversations: conversations.length,
      activeConversations,
      totalUnread,
    };
  }

  /**
   * Get message activity over time
   * @param {string} conversationId - Conversation ID
   * @param {number} days - Number of days to look back
   * @returns {Promise<object[]>} Daily message counts
   */
  static async getMessageActivity(conversationId, days = 7) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    startDate.setHours(0, 0, 0, 0);

    const result = await MessageV1.aggregate([
      {
        $match: {
          conversationId: new mongoose.Types.ObjectId(conversationId),
          createdAt: { $gte: startDate },
          deletedAt: null,
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$createdAt' },
          },
          count: { $sum: 1 },
        },
      },
      {
        $sort: { _id: 1 },
      },
    ]);

    return result.map((item) => ({
      date: item._id,
      count: item.count,
    }));
  }

  /**
   * Get response time statistics for a user
   * @param {string} userId - User ID (as receiver)
   * @param {string} conversationId - Conversation ID
   * @returns {Promise<object>} Response time stats
   */
  static async getResponseTimeStats(userId, conversationId) {
    // This is a simplified implementation
    // For production, you'd want a more sophisticated analysis
    const messages = await MessageV1.find({
      conversationId: new mongoose.Types.ObjectId(conversationId),
      deletedAt: null,
    })
      .sort({ serverSeq: 1 })
      .select('senderId createdAt')
      .lean();

    const responseTimes = [];
    let lastOtherUserMessage = null;

    for (const msg of messages) {
      if (msg.senderId.toString() !== userId && lastOtherUserMessage === null) {
        lastOtherUserMessage = msg;
      } else if (msg.senderId.toString() === userId && lastOtherUserMessage) {
        const responseTime = msg.createdAt - lastOtherUserMessage.createdAt;
        responseTimes.push(responseTime);
        lastOtherUserMessage = null;
      } else if (msg.senderId.toString() !== userId) {
        lastOtherUserMessage = msg;
      }
    }

    if (responseTimes.length === 0) {
      return { avgResponseTimeMs: null, responseCount: 0 };
    }

    const avg = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;

    return {
      avgResponseTimeMs: Math.round(avg),
      responseCount: responseTimes.length,
    };
  }
}

module.exports = AnalyticsService;
