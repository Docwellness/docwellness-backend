const { Chat, User, Conversation } = require('../models');
const config = require('../config/environment');
const { getUserFromSupabaseToken } = require('../utils/supabaseAuth');

// Store online users
const onlineUsers = new Map();

// Helper function to verify assignment between sender and receiver
const verifyAssignment = async (senderId, receiverId) => {
  const sender = await User.findById(senderId);
  const receiver = await User.findById(receiverId);

  if (!sender || !receiver) return false;

  const defaultDieticianId = config.defaultDieticianId;

  // Patients can only chat with the default dietician
  if (sender.role === 'patient') {
    return receiverId.toString() === defaultDieticianId;
  }

  // Only the default dietician can initiate chat, and only with patients
  if (sender.role === 'dietician') {
    return senderId.toString() === defaultDieticianId && receiver.role === 'patient';
  }

  return false;
};

const initializeChatSocket = (io) => {
  // Authentication middleware for socket
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;

      if (!token) {
        return next(new Error('Authentication required'));
      }

      const user = await getUserFromSupabaseToken(token);

      socket.user = user;
      next();
    } catch (error) {
      next(new Error(error.code === 'no_profile' ? 'Registration not completed' : 'Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    console.log(`User connected: ${socket.user._id}`);

    // Add user to online users
    onlineUsers.set(socket.user._id.toString(), socket.id);

    // Broadcast user online status
    socket.broadcast.emit('user_online', {
      userId: socket.user._id,
      online: true,
    });

    // Join user's personal room - prefixed to match the v1 handler (see
    // chat/socket/index.js) so a message routed through either system
    // reaches the same room regardless of which handler's connection
    // handler ran for this socket (see AI_EXECUTION_PLAN.md Phase 4,
    // P4-02). Server-derived from the authenticated socket.user.
    socket.join(`user:${socket.user._id}`);

    // Send message
    socket.on('send_message', async (data) => {
      try {
        const { receiverId, message, messageType, attachment } = data;

        // Save message to database
        const chat = await Chat.create({
          senderId: socket.user._id,
          receiverId,
          message,
          messageType: messageType || 'text',
          attachment,
        });

        const populatedChat = await Chat.findById(chat._id)
          .populate('senderId', 'profile.firstName profile.lastName profile.profileImage')
          .populate('receiverId', 'profile.firstName profile.lastName profile.profileImage');

        // Emit to receiver
        const receiverSocketId = onlineUsers.get(receiverId);
        if (receiverSocketId) {
          io.to(receiverSocketId).emit('receive_message', populatedChat);
        }

        // Confirm to sender
        socket.emit('message_sent', populatedChat);
      } catch (error) {
        socket.emit('error', { message: 'Failed to send message' });
      }
    });

    // Typing indicator
    socket.on('typing', (data) => {
      const { receiverId } = data;
      const receiverSocketId = onlineUsers.get(receiverId);

      if (receiverSocketId) {
        io.to(receiverSocketId).emit('user_typing', {
          userId: socket.user._id,
          firstName: socket.user.profile?.firstName,
        });
      }
    });

    // Stop typing indicator
    socket.on('stop_typing', (data) => {
      const { receiverId } = data;
      const receiverSocketId = onlineUsers.get(receiverId);

      if (receiverSocketId) {
        io.to(receiverSocketId).emit('user_stopped_typing', {
          userId: socket.user._id,
        });
      }
    });

    // Mark messages as read
    socket.on('mark_as_read', async (data) => {
      try {
        const { senderId } = data;

        // Mark all messages from sender as read
        await Chat.updateMany(
          {
            senderId,
            receiverId: socket.user._id,
            isRead: false,
          },
          { isRead: true }
        );

        // Notify sender that messages were read
        const senderSocketId = onlineUsers.get(senderId);
        if (senderSocketId) {
          io.to(senderSocketId).emit('messages_read', {
            readBy: socket.user._id,
          });
        }
      } catch (error) {
        socket.emit('error', { message: 'Failed to mark messages as read' });
      }
    });

    // Get online status
    socket.on('get_online_status', (data) => {
      const { userIds } = data;
      const statuses = userIds.map((userId) => ({
        userId,
        online: onlineUsers.has(userId),
      }));
      socket.emit('online_statuses', statuses);
    });

    // Conversation-based chat: sendMessage
    socket.on('sendMessage', async ({ receiverId: bodyReceiverId, message, messageType, attachment,replyTo }, callback) => {
      try {
        const senderId = socket.user._id;
        const senderRole = socket.user.role;

        let receiverId;

        // Patients automatically chat with the default dietician
        if (senderRole === 'patient') {
          receiverId = config.defaultDieticianId;
        } else if (senderRole === 'dietician') {
          // Dieticians must specify which patient to message
          if (!bodyReceiverId) {
            return callback({ success: false, message: 'receiverId is required for dietician messages' });
          }
          receiverId = bodyReceiverId;
        } else {
          return callback({ success: false, message: 'Invalid user role' });
        }

        // Validate roles and assignment
        const isAssigned = await verifyAssignment(senderId, receiverId);
        if (!isAssigned) {
          return callback({ success: false, message: 'You are not authorized to send messages to this user' });
        }

        // Ensure conversation exists
        let conversation = await Conversation.findOne({
          $and: [
            { 'participants.userId': senderId },
            { 'participants.userId': receiverId },
          ],
        });

        if (!conversation) {
          conversation = await Conversation.create({
            participants: [
              { userId: senderId },
              { userId: receiverId },
            ],
          });
        }

        // Create message - seq allocated atomically per-conversation (see
        // AI_EXECUTION_PLAN.md Phase 4, P4-03)
        const seq = await Conversation.getNextSeq(conversation._id);
        const chatMessage = await Chat.create({
          conversationId: conversation._id,
          senderId: senderId,
          receiverId,
          message: messageType === 'image' ? 'Image' : message,
          messageType: messageType || 'text',
          attachment: attachment || null,
          seq,
        });

        // Update conversation
        conversation.lastMessage = message;
        conversation.lastMessageAt = new Date();
        conversation.lastMessageSender = senderId;
        conversation.participants.forEach((p) => {
          if (p.userId.toString() !== senderId.toString()) {
            p.unreadCount += 1;
          }
        });
        await conversation.save();

        // Emit to receiver
        io.to(`user:${receiverId}`).emit('newMessage', chatMessage);
        callback({ success: true, data: chatMessage });
      } catch (error) {
        callback({ success: false, message: 'An error occurred while sending the message' });
      }
    });

    // Conversation-based chat: markAsRead
    socket.on('markAsRead', async (conversationId, callback) => {
      try {
        const userId = socket.user._id;

        const conversation = await Conversation.findById(conversationId);
        if (!conversation) {
          return callback({ success: false, message: 'Conversation not found' });
        }

        // Verify user is a participant in this conversation
        const isParticipant = conversation.participants.some((p) => p.userId.toString() === userId.toString());
        if (!isParticipant) {
          return callback({ success: false, message: 'You are not a participant in this conversation' });
        }

        // Mark messages as read
        await Chat.updateMany(
          { conversationId, receiverId: userId, isRead: false },
          { isRead: true }
        );

        // Reset unread count
        conversation.participants.forEach((p) => {
          if (p.userId.toString() === userId.toString()) {
            p.unreadCount = 0;
          }
        });
        await conversation.save();

        io.to(`user:${userId}`).emit('conversationUpdated', conversation);
        callback({ success: true });
      } catch (error) {
        callback({ success: false, message: 'An error occurred while marking messages as read' });
      }
    });

    // Disconnect
    socket.on('disconnect', () => {
      console.log(`User disconnected: ${socket.user._id}`);

      // Remove from online users
      onlineUsers.delete(socket.user._id.toString());

      // Broadcast user offline status
      socket.broadcast.emit('user_offline', {
        userId: socket.user._id,
        online: false,
      });
    });
  });

  return io;
};

// Get online users count
const getOnlineUsersCount = () => onlineUsers.size;

// Check if user is online
const isUserOnline = (userId) => onlineUsers.has(userId.toString());

module.exports = {
  initializeChatSocket,
  getOnlineUsersCount,
  isUserOnline,
};
