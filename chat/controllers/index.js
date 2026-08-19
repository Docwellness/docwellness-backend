/**
 * Chat Controllers - REST API Handlers
 */

const {
  ConversationService,
  MessageService,
  LinkPreviewService,
  MealLogSyncService,
  AnalyticsService,
  ChatLogger,
} = require('../services');
const config = require('../../config/environment');
const cloudinary = require('../../config/cloudinary');
const { cloudinaryUserFolder } = require('../../utils/cloudinaryFolder');
const { User, Conversation } = require('../../models');
const Notification = require('../../models/Notification');
const { ConversationV1 } = require('../models');
const { getOrSetJSON } = require('../../utils/cache');

const { EVENTS } = ChatLogger;

// AI_EXECUTION_PLAN.md Phase 5, P5-06 - chat unread count is read on every
// app foreground/reconnect but only actually changes on a new message or a
// mark-as-read, so a short cache absorbs repeat reads without the badge
// feeling stale. Deliberately no write-path invalidation (see
// utils/cache.js's doc comment) - 15s of staleness on an unread badge is an
// acceptable, explicitly-chosen tradeoff, not a correctness issue.
const UNREAD_COUNT_CACHE_TTL_SECONDS = 15;

/**
 * GET /v1/conversations
 * Get conversation list for current user
 */
exports.getConversations = async (req, res, next) => {
  try {
    const { q, limit = 20, cursor } = req.query;

    const result = await ConversationService.getConversations(
      req.user._id,
      {
        search: q,
        limit: parseInt(limit),
        cursor,
      },
      req.logContext
    );

    res.json({
      success: true,
      data: result.conversations,
      pagination: {
        hasMore: result.hasMore,
        nextCursor: result.nextCursor,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /v1/conversations/direct
 * Create or get direct conversation with another user
 */
exports.createDirectConversation = async (req, res, next) => {
  try {
    let { participantId } = req.body;

    // Patients automatically chat with default dietician
    if (req.user.role === 'patient') {
      participantId = config.defaultDieticianId;
    }

    if (!participantId) {
      return res.status(400).json({
        success: false,
        message: 'participantId is required',
      });
    }

    const conversation = await ConversationService.getOrCreateDirect(
      req.user._id,
      participantId,
      req.logContext
    );

    const details = await ConversationService.getById(conversation._id, req.user._id);

    res.status(201).json({
      success: true,
      data: {
        id: details._id,
        type: details.type,
        participant: details.otherUser,
        lastMessage: details.lastMessage,
        lastMessageAt: details.lastMessageAt,
        createdAt: details.createdAt,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /v1/conversations/:id/messages
 * Get messages for a conversation with pagination
 */
exports.getMessages = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { limit = 50, before_seq, after_seq } = req.query;

    // Verify participant
    const isParticipant = await ConversationService.isParticipant(id, req.user._id);
    if (!isParticipant) {
      return res.status(403).json({
        success: false,
        message: 'You are not a participant in this conversation',
      });
    }

    const result = await MessageService.getMessages({
      conversationId: id,
      limit: parseInt(limit),
      beforeSeq: before_seq ? parseInt(before_seq) : null,
      afterSeq: after_seq ? parseInt(after_seq) : null,
    });

    // Transform for response
    const messages = result.messages.map((msg) => ({
      id: msg._id,
      conversationId: msg.conversationId,
      senderId: msg.senderId,
      receiverId: msg.receiverId,
      serverSeq: msg.serverSeq,
      type: msg.type,
      content: msg.content,
      attachment: msg.attachment,
      linkPreview: msg.linkPreview,
      mealLogData: msg.mealLogData,
      customFoodData: msg.customFoodData,
      waterIntakeData: msg.waterIntakeData,
      dietPlanData: msg.dietPlanData,
      replyTo: msg.replyTo,
      status: msg.status,
      createdAt: msg.createdAt,
      isMe: msg.senderId.toString() === req.user._id.toString(),
    }));

    res.json({
      success: true,
      data: messages,
      pagination: {
        hasMore: result.hasMore,
        nextCursor: result.nextCursor,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /v1/conversations/:id/messages/sync
 * Reconnect sync (see AI_EXECUTION_PLAN.md Phase 4, P4-07) - a client that
 * was offline/backgrounded calls this with the highest serverSeq it has
 * cached locally to catch up on exactly what it missed, without re-fetching
 * full history. Deliberately a separate, narrower endpoint from the general
 * getMessages above (which also supports before_seq/backward pagination for
 * scrolling into older history) - this one always returns ascending order
 * from after_seq, matching the identical semantics the socket-based 'sync'
 * event (chat/socket/index.js) already used for the same purpose, so a
 * client can use either transport interchangeably.
 */
exports.syncMessages = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { after_seq, limit = 100 } = req.query;

    const isParticipant = await ConversationService.isParticipant(id, req.user._id);
    if (!isParticipant) {
      return res.status(403).json({
        success: false,
        message: 'You are not a participant in this conversation',
      });
    }

    const result = await MessageService.getMessages({
      conversationId: id,
      limit: parseInt(limit),
      afterSeq: after_seq ? parseInt(after_seq) : null,
    });

    const messages = result.messages.map((msg) => ({
      id: msg._id,
      conversationId: msg.conversationId,
      senderId: msg.senderId,
      receiverId: msg.receiverId,
      serverSeq: msg.serverSeq,
      type: msg.type,
      content: msg.content,
      attachment: msg.attachment,
      linkPreview: msg.linkPreview,
      mealLogData: msg.mealLogData,
      customFoodData: msg.customFoodData,
      waterIntakeData: msg.waterIntakeData,
      dietPlanData: msg.dietPlanData,
      replyTo: msg.replyTo,
      status: msg.status,
      createdAt: msg.createdAt,
      isMe: msg.senderId.toString() === req.user._id.toString(),
    }));

    res.json({
      success: true,
      data: messages,
      pagination: {
        hasMore: result.hasMore,
        nextCursor: result.nextCursor,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /v1/conversations/:id/messages
 * Send a message (REST fallback with idempotency support)
 */
exports.sendMessage = async (req, res, next) => {
  try {
    const { id: conversationId } = req.params;
    const { client_message_id, type = 'text', content = '', reply_to } = req.body;

    if (!client_message_id) {
      return res.status(400).json({
        success: false,
        message: 'client_message_id is required',
      });
    }

    // Verify participant
    const conversation = await ConversationService.getById(conversationId, req.user._id);
    if (!conversation) {
      return res.status(403).json({
        success: false,
        message: 'You are not a participant in this conversation',
      });
    }

    // Determine receiver
    const receiverId =
      conversation.otherUser?.id ||
      conversation.participants.find((p) => p.userId.toString() !== req.user._id.toString())
        ?.userId;

    if (!receiverId) {
      return res.status(400).json({
        success: false,
        message: 'Could not determine message receiver',
      });
    }

    // Handle attachment if present
    let attachment = null;
    if (req.file) {
      const result = await cloudinary.uploader.upload(req.file.path, {
        folder: cloudinaryUserFolder(req.user._id, 'chat'),
      });
      attachment = {
        url: result.secure_url,
        mimeType: req.file.mimetype,
        fileName: req.file.originalname,
        fileSize: req.file.size,
      };
    }

    // Build reply reference
    let replyTo = null;
    if (reply_to) {
      const replyMsg = await require('../models').MessageV1.findById(reply_to);
      if (replyMsg) {
        replyTo = {
          messageId: replyMsg._id,
          content: replyMsg.content,
          senderId: replyMsg.senderId,
          type: replyMsg.type,
        };
      }
    }

    const result = await MessageService.sendMessage(
      {
        conversationId,
        senderId: req.user._id,
        receiverId,
        clientMessageId: client_message_id,
        type: attachment ? 'image' : type,
        content,
        attachment,
        replyTo,
      },
      req.logContext
    );

    // Emit via Socket.IO if available
    const io = req.app.get('io');
    if (io && !result.dedup) {
      io.to(`user:${receiverId}`).emit('msg.new', {
        message: result.message,
        conversation_id: conversationId,
      });

      ChatLogger.info(EVENTS.MSG_FANOUT, {
        ...req.logContext,
        message_id: result.message._id,
        conversation_id: conversationId,
        receiver_id: receiverId,
      });
    }

    // Create notification for receiver
    if (!result.dedup) {
      try {
        const sender = await User.findById(req.user._id).select('profile.fullName role').lean();
        const senderName = sender?.profile?.fullName || 'User';
        const msgType = result.message.type;
        const notifTitle = `New message from ${senderName}`;
        const notifMessage =
          msgType === 'image' ? '📷 Sent a photo' : (result.message.content || '').slice(0, 100);

        const notif = await Notification.create({
          userId: receiverId,
          title: notifTitle,
          message: notifMessage || 'New message',
          type: 'chat',
          referenceId: conversationId,
          referenceModel: 'Chat',
        });

        // Emit real-time notification to receiver
        const io = req.app.get('io');
        if (io) {
          io.to(`user:${receiverId}`).emit('notification.new', {
            id: notif._id,
            title: notif.title,
            message: notif.message,
            type: notif.type,
            referenceId: notif.referenceId?.toString(),
            createdAt: notif.createdAt,
          });
        }
      } catch (notifErr) {
        ChatLogger.error('notification_create_error', { ...req.logContext, error: notifErr });
      }
    }

    // Send ACK
    ChatLogger.info(EVENTS.MSG_ACK, {
      ...req.logContext,
      message_id: result.ack.message_id,
      server_seq: result.ack.server_seq,
      client_message_id: client_message_id,
      dedup: result.dedup,
    });

    res.status(result.dedup ? 200 : 201).json({
      success: true,
      dedup: result.dedup,
      data: {
        id: result.message._id,
        server_seq: result.message.serverSeq,
        client_message_id: result.message.clientMessageId,
        createdAt: result.message.createdAt,
        type: result.message.type,
        content: result.message.content,
        attachment: result.message.attachment,
        linkPreview: result.message.linkPreview,
      },
      ack: result.ack,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /v1/conversations/:id/read
 * Mark conversation as read up to a sequence
 */
exports.markRead = async (req, res, next) => {
  try {
    const { id: conversationId } = req.params;
    const { last_read_seq } = req.body;

    if (typeof last_read_seq !== 'number') {
      return res.status(400).json({
        success: false,
        message: 'last_read_seq is required',
      });
    }

    // Verify participant
    const isParticipant = await ConversationService.isParticipant(conversationId, req.user._id);
    if (!isParticipant) {
      return res.status(403).json({
        success: false,
        message: 'You are not a participant in this conversation',
      });
    }

    await MessageService.markRead(conversationId, req.user._id, last_read_seq, req.logContext);

    // Notify other participant via socket
    const io = req.app.get('io');
    if (io) {
      const conversation = await ConversationService.getById(conversationId, req.user._id);
      if (conversation?.otherUser) {
        io.to(`user:${conversation.otherUser.id}`).emit('conv.read', {
          conversation_id: conversationId,
          reader_id: req.user._id,
          last_read_seq,
        });
      }
    }

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /v1/messages/:id/delivered
 * Mark a message as delivered
 */
exports.markDelivered = async (req, res, next) => {
  try {
    const { id: messageId } = req.params;

    const message = await MessageService.markDelivered(messageId, req.logContext);

    if (!message) {
      return res.status(404).json({
        success: false,
        message: 'Message not found',
      });
    }

    // Notify sender via socket
    const io = req.app.get('io');
    if (io) {
      io.to(`user:${message.senderId}`).emit('msg.status', {
        message_id: messageId,
        status: 'delivered',
        delivered_at: message.deliveredAt,
      });
    }

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /v1/media/presign
 * Get presigned URL for media upload
 */
exports.presignMedia = async (req, res, next) => {
  try {
    const { file_name, content_type } = req.body;

    if (!file_name || !content_type) {
      return res.status(400).json({
        success: false,
        message: 'file_name and content_type are required',
      });
    }

    ChatLogger.info(EVENTS.MEDIA_PRESIGN, {
      ...req.logContext,
      file_name,
      content_type,
    });

    // For Cloudinary, we use direct upload
    // Generate a unique upload preset or signed params
    const timestamp = Math.round(new Date().getTime() / 1000);
    const folder = 'docwellness/chat';

    // Simple unsigned upload URL (for production, use signed uploads)
    res.json({
      success: true,
      data: {
        upload_url: `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/auto/upload`,
        folder,
        timestamp,
        // For production: include signature
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /v1/link/preview
 * Get link preview for a URL
 */
exports.getLinkPreview = async (req, res, next) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({
        success: false,
        message: 'url is required',
      });
    }

    const preview = await LinkPreviewService.getPreview(url, req.logContext);

    res.json({
      success: true,
      data: preview,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /v1/integrations/meal-logs/events
 * Webhook endpoint for external meal log events
 */
exports.mealLogWebhook = async (req, res, next) => {
  try {
    const {
      event_type,
      event_id,
      occurred_at,
      conversation_id,
      meal_log_id,
      meal_log_version,
      actor_user_id,
      snapshot,
    } = req.body;

    // Validate required fields
    if (!event_type || !meal_log_id || !meal_log_version || !actor_user_id) {
      return res.status(400).json({
        success: false,
        message: 'event_type, meal_log_id, meal_log_version, and actor_user_id are required',
      });
    }

    const result = await MealLogSyncService.ingestFromInternal(
      {
        event_type,
        event_id,
        occurred_at: occurred_at ? new Date(occurred_at) : new Date(),
        conversation_id,
        meal_log_id,
        meal_log_version,
        actor_user_id,
        snapshot: snapshot || {},
      },
      req.logContext
    );

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /v1/conversations/:id/analytics
 * Get basic analytics for a conversation
 */
exports.getAnalytics = async (req, res, next) => {
  try {
    const { id: conversationId } = req.params;

    // Verify participant
    const isParticipant = await ConversationService.isParticipant(conversationId, req.user._id);
    if (!isParticipant) {
      return res.status(403).json({
        success: false,
        message: 'You are not a participant in this conversation',
      });
    }

    const [messageCounts, activity] = await Promise.all([
      AnalyticsService.getMessageCounts(conversationId),
      AnalyticsService.getMessageActivity(conversationId, 7),
    ]);

    res.json({
      success: true,
      data: {
        messageCounts,
        activity,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /v1/chat/unread-count
 * AI_EXECUTION_PLAN.md Phase 5, P5-04 - total unread message count across
 * every conversation for the current user (patient or dietician), summed
 * rather than counted per-conversation. V1 unreadCount is the source of
 * truth for any conversation that exists there (mirrors the merge pattern
 * already used in controllers/dietician/dashboardController.js and
 * controllers/chatController.js's getConversations) - legacy-only
 * conversations (not yet touched by the v1 system) fall back to their own
 * unreadCount.
 */
exports.getUnreadCount = async (req, res, next) => {
  try {
    const userId = req.user._id;

    const unreadCount = await getOrSetJSON(
      `chat:unread-count:${userId}`,
      UNREAD_COUNT_CACHE_TTL_SECONDS,
      async () => {
        const [legacyConversations, v1Conversations] = await Promise.all([
          Conversation.find({ 'participants.userId': userId }).lean(),
          ConversationV1.find({ 'participants.userId': userId }).lean(),
        ]);

        const v1UnreadByOtherUser = {};
        v1Conversations.forEach((conv) => {
          const me = conv.participants.find((p) => String(p.userId) === String(userId));
          const other = conv.participants.find((p) => String(p.userId) !== String(userId));
          if (me && other) v1UnreadByOtherUser[String(other.userId)] = me.unreadCount || 0;
        });

        let count = 0;
        const countedOtherUsers = new Set();

        legacyConversations.forEach((conv) => {
          const me = conv.participants.find((p) => String(p.userId) === String(userId));
          const other = conv.participants.find((p) => String(p.userId) !== String(userId));
          if (!me || !other) return;
          const otherId = String(other.userId);
          const unread = v1UnreadByOtherUser[otherId] !== undefined ? v1UnreadByOtherUser[otherId] : (me.unreadCount || 0);
          count += unread;
          countedOtherUsers.add(otherId);
        });

        v1Conversations.forEach((conv) => {
          const me = conv.participants.find((p) => String(p.userId) === String(userId));
          const other = conv.participants.find((p) => String(p.userId) !== String(userId));
          if (!me || !other) return;
          const otherId = String(other.userId);
          if (countedOtherUsers.has(otherId)) return;
          count += me.unreadCount || 0;
        });

        return count;
      }
    );

    res.json({ success: true, data: { unreadCount } });
  } catch (error) {
    next(error);
  }
};
