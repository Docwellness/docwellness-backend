/**
 * Enhanced Socket.IO Chat Gateway
 * WhatsApp-like real-time messaging with proper ACKs and presence
 */

const crypto = require('crypto');
const { User } = require('../../models');
const { ConversationV1, MessageV1 } = require('../models');
const {
  MessageService,
  ConversationService,
  PresenceService,
  MealLogSyncService,
  ChatLogger,
} = require('../services');
const config = require('../../config/environment');
const Notification = require('../../models/Notification');
const { getUserFromSupabaseToken } = require('../../utils/supabaseAuth');

const { EVENTS } = ChatLogger;

// Store IO instance for external access
let ioInstance = null;

/**
 * Generate session ID for socket connections
 */
function generateSessionId() {
  return `sess_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Initialize enhanced chat socket handlers
 * @param {object} io - Socket.IO server instance
 */
function initializeChatSocketV1(io) {
  ioInstance = io;

  // Share IO with MealLogSyncService for real-time updates
  MealLogSyncService.setIO(io);

  // Namespace for v1 chat (optional - can use default)
  const chatNamespace = io;

  // Authentication middleware
  chatNamespace.use(async (socket, next) => {
    const startTime = Date.now();
    const sessionId = generateSessionId();
    socket.sessionId = sessionId;

    try {
      const token = socket.handshake.auth.token;
      const traceId =
        socket.handshake.auth.traceId || `trace_${crypto.randomBytes(8).toString('hex')}`;

      socket.traceId = traceId;
      socket.logContext = {
        session_id: sessionId,
        trace_id: traceId,
      };

      ChatLogger.info(EVENTS.WS_CONNECT, {
        session_id: sessionId,
        trace_id: traceId,
        ip: socket.handshake.address,
      });

      if (!token) {
        ChatLogger.warn(EVENTS.WS_AUTH_FAIL, {
          ...socket.logContext,
          reason: 'no_token',
          latency_ms: Date.now() - startTime,
        });
        return next(new Error('Authentication required'));
      }

      const user = await getUserFromSupabaseToken(token);

      socket.user = user;
      socket.logContext.user_id = user._id.toString();

      ChatLogger.timed(EVENTS.WS_AUTH_OK, startTime, {
        ...socket.logContext,
        user_id: user._id,
        role: user.role,
      });

      next();
    } catch (error) {
      ChatLogger.warn(EVENTS.WS_AUTH_FAIL, {
        ...socket.logContext,
        reason: error.message,
        latency_ms: Date.now() - startTime,
      });
      next(new Error(error.code === 'no_profile' ? 'Registration not completed' : 'Invalid token'));
    }
  });

  // Connection handler
  chatNamespace.on('connection', (socket) => {
    const userId = socket.user._id.toString();

    // Mark user as online
    PresenceService.setOnline(userId, socket.id, socket.logContext);

    // Join user's personal room
    socket.join(userId);

    // Emit auth success to client
    socket.emit('ws.auth_ok', {
      user_id: userId,
      session_id: socket.sessionId,
    });

    // Broadcast online status
    socket.broadcast.emit('presence.update', {
      user_id: userId,
      status: 'online',
      timestamp: new Date(),
    });

    // ==========================================
    // Chat Join/Leave
    // ==========================================

    socket.on('chat.join', async (data, callback) => {
      const startTime = Date.now();
      const { conversation_id } = data;

      try {
        const isParticipant = await ConversationService.isParticipant(conversation_id, userId);

        if (!isParticipant) {
          ChatLogger.warn(EVENTS.CHAT_JOIN, {
            ...socket.logContext,
            conversation_id,
            success: false,
            reason: 'not_participant',
          });

          return callback?.({
            success: false,
            error: { code: 'NOT_PARTICIPANT', message: 'You are not a participant' },
          });
        }

        socket.join(`conv:${conversation_id}`);

        ChatLogger.timed(EVENTS.CHAT_JOIN, startTime, {
          ...socket.logContext,
          conversation_id,
          success: true,
        });

        socket.emit('chat.joined', { conversation_id });
        callback?.({ success: true });
      } catch (error) {
        ChatLogger.error(EVENTS.ERROR, {
          ...socket.logContext,
          conversation_id,
          error,
          operation: 'chat.join',
        });
        callback?.({
          success: false,
          error: { code: 'INTERNAL_ERROR', message: 'Failed to join chat' },
        });
      }
    });

    socket.on('chat.leave', (data) => {
      const { conversation_id } = data;
      socket.leave(`conv:${conversation_id}`);

      ChatLogger.info(EVENTS.CHAT_LEAVE, {
        ...socket.logContext,
        conversation_id,
      });
    });

    // ==========================================
    // Message Sending
    // ==========================================

    socket.on('msg.send', async (data, callback) => {
      const startTime = Date.now();
      const {
        conversation_id,
        receiver_id,
        client_message_id,
        type = 'text',
        content = '',
        attachment,
        reply_to,
        water_intake_data,
        diet_plan_data,
        custom_food_data,
        meal_log_data,
        confession_data,
        allergy_report_data,
        recommendation_data,
      } = data;

      const logContext = {
        ...socket.logContext,
        conversation_id,
        client_message_id,
      };

      try {
        // Validate required fields
        if (!client_message_id) {
          return callback?.({
            success: false,
            error: { code: 'MISSING_CLIENT_ID', message: 'client_message_id is required' },
          });
        }

        // Determine receiver
        let receiverId = receiver_id;
        if (socket.user.role === 'patient') {
          receiverId = config.defaultDieticianId;
        }

        if (!receiverId) {
          return callback?.({
            success: false,
            error: { code: 'MISSING_RECEIVER', message: 'receiver_id is required' },
          });
        }

        // Get or create conversation if not provided
        let convId = conversation_id;
        if (!convId) {
          const conv = await ConversationService.getOrCreateDirect(userId, receiverId, logContext);
          convId = conv._id.toString();
        }

        // Verify participation
        const isParticipant = await ConversationService.isParticipant(convId, userId);
        if (!isParticipant) {
          return callback?.({
            success: false,
            error: { code: 'NOT_PARTICIPANT', message: 'You are not a participant' },
          });
        }

        // Build reply reference
        let replyTo = null;
        if (reply_to) {
          const replyMsg = await MessageV1.findById(reply_to);
          if (replyMsg) {
            replyTo = {
              messageId: replyMsg._id,
              content: replyMsg.content?.substring(0, 100),
              senderId: replyMsg.senderId,
              type: replyMsg.type,
            };
          }
        }

        // Send message
        const result = await MessageService.sendMessage(
          {
            conversationId: convId,
            senderId: userId,
            receiverId,
            clientMessageId: client_message_id,
            type,
            content,
            attachment,
            replyTo,
            mealLogData: meal_log_data,
            waterIntakeData: water_intake_data,
            dietPlanData: diet_plan_data,
            customFoodData: custom_food_data,
            confessionData: confession_data,
            allergyReportData: allergy_report_data,
            recommendationData: recommendation_data,
          },
          logContext
        );

        // Send ACK to sender
        ChatLogger.timed(EVENTS.MSG_ACK, startTime, {
          ...logContext,
          message_id: result.ack.message_id,
          server_seq: result.ack.server_seq,
          dedup: result.dedup,
        });

        callback?.({
          success: true,
          dedup: result.dedup,
          ack: {
            message_id: result.ack.message_id,
            server_seq: result.ack.server_seq,
            created_at: result.ack.created_at,
          },
        });

        // Fanout to receiver (if not dedup)
        if (!result.dedup) {
          io.to(receiverId.toString()).emit('msg.new', {
            message: {
              id: result.message._id,
              conversationId: result.message.conversationId,
              senderId: result.message.senderId,
              receiverId: result.message.receiverId,
              serverSeq: result.message.serverSeq,
              type: result.message.type,
              content: result.message.content,
              attachment: result.message.attachment,
              linkPreview: result.message.linkPreview,
              replyTo: result.message.replyTo,
              mealLogData: result.message.mealLogData,
              waterIntakeData: result.message.waterIntakeData,
              dietPlanData: result.message.dietPlanData,
              customFoodData: result.message.customFoodData,
              confessionData: result.message.confessionData,
              allergyReportData: result.message.allergyReportData,
              recommendationData: result.message.recommendationData,
              status: result.message.status,
              createdAt: result.message.createdAt,
            },
            conversation_id: convId,
          });

          ChatLogger.info(EVENTS.MSG_FANOUT, {
            ...logContext,
            message_id: result.message._id,
            receiver_id: receiverId,
          });

          // Create notification for receiver
          try {
            const sender = await User.findById(userId).select('profile.fullName role').lean();
            const senderRole = socket.user.role;
            const senderName =
              sender?.profile?.fullName || (senderRole === 'patient' ? 'Patient' : 'Doctor');
            const notifTitle = `New message from ${senderName}`;
            const msgType = result.message.type;
            const notifMessage =
              msgType === 'image'
                ? '📷 Sent a photo'
                : msgType === 'confession_box'
                  ? '🍕 Confession Box'
                  : msgType === 'allergy_report'
                    ? '⚠️ Allergy Report'
                    : msgType === 'doctor_recommendation'
                      ? '💊 Sent a recommendation'
                      : (result.message.content || '').slice(0, 100);

            const notif = await Notification.create({
              userId: receiverId,
              title: notifTitle,
              message: notifMessage || 'New message',
              type: 'chat',
              referenceId: result.message.conversationId,
              referenceModel: 'Chat',
            });

            // Emit real-time notification to receiver
            io.to(receiverId.toString()).emit('notification.new', {
              id: notif._id,
              title: notif.title,
              message: notif.message,
              type: notif.type,
              referenceId: notif.referenceId?.toString(),
              createdAt: notif.createdAt,
            });
          } catch (notifErr) {
            ChatLogger.error('notification_create_error', { ...logContext, error: notifErr });
          }
        }
      } catch (error) {
        ChatLogger.error(EVENTS.ERROR, {
          ...logContext,
          error,
          operation: 'msg.send',
        });
        callback?.({
          success: false,
          error: { code: 'SEND_FAILED', message: 'Failed to send message' },
        });
      }
    });

    // ==========================================
    // Message Status
    // ==========================================

    socket.on('msg.status', async (data, callback) => {
      const { message_id, status } = data;

      try {
        if (status === 'delivered') {
          const message = await MessageService.markDelivered(message_id, socket.logContext);

          if (message) {
            // Notify sender
            io.to(message.senderId.toString()).emit('msg.status', {
              message_id,
              status: 'delivered',
              delivered_at: message.deliveredAt,
            });
          }
        }

        callback?.({ success: true });
      } catch (error) {
        ChatLogger.error(EVENTS.ERROR, {
          ...socket.logContext,
          message_id,
          error,
          operation: 'msg.status',
        });
        callback?.({ success: false });
      }
    });

    // ==========================================
    // Conversation Read
    // ==========================================

    socket.on('conv.read', async (data, callback) => {
      const { conversation_id, last_read_seq } = data;

      try {
        await MessageService.markRead(conversation_id, userId, last_read_seq, socket.logContext);

        // Notify other participant
        const conversation = await ConversationService.getById(conversation_id, userId);
        if (conversation?.otherUser) {
          io.to(conversation.otherUser.id.toString()).emit('conv.read', {
            conversation_id,
            reader_id: userId,
            last_read_seq,
          });
        }

        callback?.({ success: true });
      } catch (error) {
        ChatLogger.error(EVENTS.ERROR, {
          ...socket.logContext,
          conversation_id,
          error,
          operation: 'conv.read',
        });
        callback?.({ success: false });
      }
    });

    // ==========================================
    // Typing Indicators
    // ==========================================

    socket.on('typing.start', (data) => {
      const { conversation_id, receiver_id } = data;

      ChatLogger.debug(EVENTS.TYPING_START, {
        ...socket.logContext,
        conversation_id,
      });

      // Broadcast to conversation room or specific receiver
      if (receiver_id) {
        io.to(receiver_id.toString()).emit('typing', {
          conversation_id,
          user_id: userId,
          typing: true,
        });
      } else if (conversation_id) {
        socket.to(`conv:${conversation_id}`).emit('typing', {
          conversation_id,
          user_id: userId,
          typing: true,
        });
      }
    });

    socket.on('typing.stop', (data) => {
      const { conversation_id, receiver_id } = data;

      ChatLogger.debug(EVENTS.TYPING_STOP, {
        ...socket.logContext,
        conversation_id,
      });

      if (receiver_id) {
        io.to(receiver_id.toString()).emit('typing', {
          conversation_id,
          user_id: userId,
          typing: false,
        });
      } else if (conversation_id) {
        socket.to(`conv:${conversation_id}`).emit('typing', {
          conversation_id,
          user_id: userId,
          typing: false,
        });
      }
    });

    // ==========================================
    // Presence
    // ==========================================

    socket.on('presence.ping', () => {
      PresenceService.ping(userId);

      ChatLogger.debug(EVENTS.PRESENCE_PING, {
        ...socket.logContext,
      });
    });

    socket.on('presence.get', (data, callback) => {
      const { user_ids } = data;
      const statuses = PresenceService.getBulkStatus(user_ids || []);
      callback?.({ success: true, data: statuses });
    });

    // ==========================================
    // Sync (for reconnection)
    // ==========================================

    socket.on('sync', async (data, callback) => {
      const { conversation_id, after_seq } = data;

      try {
        const result = await MessageService.getMessages({
          conversationId: conversation_id,
          afterSeq: after_seq,
          limit: 100,
        });

        callback?.({
          success: true,
          data: {
            messages: result.messages,
            hasMore: result.hasMore,
          },
        });
      } catch (error) {
        ChatLogger.error(EVENTS.ERROR, {
          ...socket.logContext,
          conversation_id,
          error,
          operation: 'sync',
        });
        callback?.({ success: false });
      }
    });

    // ==========================================
    // Error Handler
    // ==========================================

    socket.on('error', (error) => {
      ChatLogger.error(EVENTS.ERROR, {
        ...socket.logContext,
        error: error.message,
        operation: 'socket_error',
      });
    });

    // ==========================================
    // Disconnect
    // ==========================================

    socket.on('disconnect', (reason) => {
      PresenceService.setOffline(userId, {
        ...socket.logContext,
        reason,
      });

      // Broadcast offline status
      socket.broadcast.emit('presence.update', {
        user_id: userId,
        status: 'offline',
        last_seen: new Date(),
      });

      ChatLogger.info(EVENTS.WS_DISCONNECT, {
        ...socket.logContext,
        reason,
      });
    });
  });

  return io;
}

/**
 * Get Socket.IO instance for external use
 */
function getChatIO() {
  return ioInstance;
}

module.exports = {
  initializeChatSocketV1,
  getChatIO,
};
