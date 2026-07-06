/**
 * ConversationService - Conversation Operations
 */

const mongoose = require('mongoose');
const { ConversationV1 } = require('../models');
const { User } = require('../../models');
const config = require('../../config/environment');
const ChatLogger = require('./ChatLogger');

const { EVENTS } = ChatLogger;

class ConversationService {
  /**
   * Get or create a direct conversation between two users
   * @param {string} userId1 - First user ID
   * @param {string} userId2 - Second user ID
   * @param {object} logContext - Logging context
   * @returns {Promise<object>} Conversation document
   */
  static async getOrCreateDirect(userId1, userId2, logContext = {}) {
    const startTime = Date.now();

    let conversation = await ConversationV1.findOrCreateDirect(userId1, userId2);
    const wasCreated = conversation.createdAt.getTime() === conversation.updatedAt.getTime();

    if (wasCreated) {
      ChatLogger.timed(EVENTS.CONV_CREATED, startTime, {
        ...logContext,
        conversation_id: conversation._id,
        participants: [userId1, userId2],
      });
    }

    return conversation;
  }

  /**
   * Get conversations for a user with unread counts and last message
   * @param {string} userId - User ID
   * @param {object} options - Query options
   * @param {object} logContext - Logging context
   * @returns {Promise<object>} Conversations with metadata
   */
  static async getConversations(userId, options = {}, logContext = {}) {
    const startTime = Date.now();
    const { limit = 20, cursor = null, search = null } = options;

    const query = {
      'participants.userId': new mongoose.Types.ObjectId(userId),
      isActive: true,
    };

    // Cursor-based pagination
    if (cursor) {
      query.lastMessageAt = { $lt: new Date(cursor) };
    }

    let conversations = await ConversationV1.find(query)
      .sort({ lastMessageAt: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = conversations.length > limit;
    if (hasMore) {
      conversations.pop();
    }

    // Get participant user details
    const participantIds = new Set();
    conversations.forEach((conv) => {
      conv.participants.forEach((p) => {
        if (p.userId.toString() !== userId) {
          participantIds.add(p.userId.toString());
        }
      });
    });

    const users = await User.find({
      _id: { $in: Array.from(participantIds) },
    })
      .select('profile.fullName profile.avatarUrl profile.profileImage role')
      .lean();

    const userMap = new Map();
    users.forEach((u) => userMap.set(u._id.toString(), u));

    // Search filter (client-side for now, can optimize with aggregation)
    if (search) {
      const searchLower = search.toLowerCase();
      conversations = conversations.filter((conv) => {
        const otherParticipant = conv.participants.find((p) => p.userId.toString() !== userId);
        if (otherParticipant) {
          const user = userMap.get(otherParticipant.userId.toString());
          if (user && user.profile?.fullName) {
            return user.profile.fullName.toLowerCase().includes(searchLower);
          }
        }
        return false;
      });
    }

    // Format response
    const result = conversations.map((conv) => {
      const myParticipant = conv.participants.find((p) => p.userId.toString() === userId);
      const otherParticipant = conv.participants.find((p) => p.userId.toString() !== userId);
      const otherUser = otherParticipant ? userMap.get(otherParticipant.userId.toString()) : null;

      return {
        id: conv._id,
        type: conv.type,
        unreadCount: myParticipant?.unreadCount || 0,
        lastReadSeq: myParticipant?.lastReadSeq || 0,
        lastMessage: conv.lastMessage
          ? {
              content: conv.lastMessage.content,
              type: conv.lastMessage.type,
              createdAt: conv.lastMessage.createdAt,
              senderId: conv.lastMessage.senderId,
              isMe: conv.lastMessage.senderId?.toString() === userId,
            }
          : null,
        lastMessageAt: conv.lastMessageAt,
        participant: otherUser
          ? {
              id: otherUser._id,
              name: otherUser.profile?.fullName || 'Unknown',
              avatar: otherUser.profile?.avatarUrl || otherUser.profile?.profileImage || null,
              role: otherUser.role,
            }
          : null,
        createdAt: conv.createdAt,
      };
    });

    ChatLogger.timed(EVENTS.CONV_FETCH, startTime, {
      ...logContext,
      user_id: userId,
      count: result.length,
      has_more: hasMore,
    });

    return {
      conversations: result,
      hasMore,
      nextCursor:
        hasMore && conversations.length > 0
          ? conversations[conversations.length - 1].lastMessageAt?.toISOString()
          : null,
    };
  }

  /**
   * Get conversation by ID with participant details
   * @param {string} conversationId - Conversation ID
   * @param {string} userId - Requesting user ID
   * @returns {Promise<object|null>} Conversation with details
   */
  static async getById(conversationId, userId) {
    const conversation = await ConversationV1.findOne({
      _id: conversationId,
      'participants.userId': new mongoose.Types.ObjectId(userId),
    }).lean();

    if (!conversation) return null;

    // Get other participant
    const otherParticipant = conversation.participants.find((p) => p.userId.toString() !== userId);

    if (!otherParticipant) return conversation;

    const otherUser = await User.findById(otherParticipant.userId)
      .select('profile.fullName profile.avatarUrl profile.profileImage role')
      .lean();

    return {
      ...conversation,
      otherUser: otherUser
        ? {
            id: otherUser._id,
            name: otherUser.profile?.fullName || 'Unknown',
            avatar: otherUser.profile?.avatarUrl || otherUser.profile?.profileImage || null,
            role: otherUser.role,
          }
        : null,
    };
  }

  /**
   * Check if user is participant in conversation
   * @param {string} conversationId - Conversation ID
   * @param {string} userId - User ID
   * @returns {Promise<boolean>}
   */
  static async isParticipant(conversationId, userId) {
    // Check in V1 collection first
    const countV1 = await ConversationV1.countDocuments({
      _id: conversationId,
      'participants.userId': new mongoose.Types.ObjectId(userId),
    });
    if (countV1 > 0) return true;

    // Also check in old Conversation collection for backward compatibility
    const Conversation = require('../../models/Conversation');
    const countOld = await Conversation.countDocuments({
      _id: conversationId,
      'participants.userId': new mongoose.Types.ObjectId(userId),
    });
    return countOld > 0;
  }

  /**
   * Get default conversation partner for a user based on role
   * Patients -> default dietician
   * @param {string} userId - User ID
   * @param {string} userRole - User role
   * @returns {Promise<string>} Partner user ID
   */
  static async getDefaultPartner(userId, userRole) {
    if (userRole === 'patient') {
      return config.defaultDieticianId;
    }
    // Dieticians must specify partner
    return null;
  }
}

module.exports = ConversationService;
