const socketIO = require('socket.io');
const jwt = require('jsonwebtoken');
const Conversation = require('../models/Conversation');
const Chat = require('../models/Chat');
const User = require('../models/User');
const config = require('../config/environment');

module.exports = (server) => {
  const io = socketIO(server);

  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication error'));
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
      if (err) {
        return next(new Error('Authentication error'));
      }
      socket.user = decoded;
      next();
    });
  });

  // Updated verifyAssignment to use defaultDieticianId
  const verifyAssignment = async (senderId, receiverId) => {
    const sender = await User.findById(senderId);
    const receiver = await User.findById(receiverId);

    if (!sender || !receiver) return false;

    const defaultDieticianId = config.defaultDieticianId;

    // Patients can chat with the default dietician
    if (sender.role === 'patient') {
      return receiverId.toString() === defaultDieticianId;
    }

    // Default dietician can chat with any patient
    if (sender.role === 'dietician') {
      return senderId.toString() === defaultDieticianId && receiver.role === 'patient';
    }

    return false;
  };

  io.on('connection', (socket) => {
    const userId = socket.user._id || socket.user.id;
    console.log(`User ${userId} connected via socket`);
    socket.join(userId);

    // Handle authenticate event
    socket.on('authenticate', (data) => {
      console.log(`User authenticated: ${data.userId}`);
      socket.join(data.userId);
    });

    // Handle join_room event
    socket.on('join_room', (conversationId) => {
      socket.join(conversationId);
      console.log(`User ${userId} joined room: ${conversationId}`);
    });

    // Handle leave_room event
    socket.on('leave_room', (conversationId) => {
      socket.leave(conversationId);
      console.log(`User ${userId} left room: ${conversationId}`);
    });

    socket.on('disconnect', () => {
      console.log(`User ${userId} disconnected`);
    });

    // Handle send_message event (matching Flutter client)
    socket.on('send_message', async (data) => {
      try {
        const { conversationId, receiverId, content, messageType = 'text', metadata } = data;
        const senderId = userId;

        console.log(`📨 send_message from ${senderId} to ${receiverId}: ${content}`);

        // Validate roles and assignment
        const isAssigned = await verifyAssignment(senderId, receiverId);
        if (!isAssigned) {
          socket.emit('message_error', {
            message: 'You can only chat with your assigned dietician',
          });
          return;
        }

        // Ensure conversation exists
        let conversation = await Conversation.findById(conversationId);
        if (!conversation) {
          conversation = await Conversation.findOne({
            $and: [{ 'participants.userId': senderId }, { 'participants.userId': receiverId }],
          });
        }

        if (!conversation) {
          conversation = await Conversation.create({
            participants: [{ userId: senderId }, { userId: receiverId }],
          });
        }

        // Create message
        const chatMessage = await Chat.create({
          conversationId: conversation._id,
          senderId,
          receiverId,
          message: content,
          messageType,
        });

        // Update conversation
        conversation.lastMessage = content;
        conversation.lastMessageAt = new Date();
        conversation.lastMessageSender = senderId;
        conversation.participants.forEach((p) => {
          if (p.userId.toString() !== senderId.toString()) {
            p.unreadCount += 1;
          }
        });
        await conversation.save();

        const messageData = {
          id: chatMessage._id,
          conversationId: conversation._id,
          senderId,
          receiverId,
          message: content,
          content: content,
          messageType,
          createdAt: chatMessage.createdAt,
          isRead: false,
        };

        // Emit to sender (confirmation)
        socket.emit('message_sent', messageData);

        // Emit to receiver
        io.to(receiverId.toString()).emit('new_message', messageData);
        io.to(conversationId).emit('new_message', messageData);

        console.log(`✅ Message sent successfully`);
      } catch (error) {
        console.error('❌ Error sending message:', error);
        socket.emit('message_error', { message: 'An error occurred while sending the message' });
      }
    });

    // Legacy sendMessage event (for backward compatibility)
    socket.on('sendMessage', async ({ receiverId, message, messageType, attachment }, callback) => {
      try {
        const senderId = socket.user._id || socket.user.id;

        // Validate roles and assignment
        const isAssigned = await verifyAssignment(senderId, receiverId);
        if (!isAssigned) {
          return callback({
            success: false,
            message: 'You can only chat with your assigned dietician/patient',
          });
        }

        // Ensure conversation exists
        let conversation = await Conversation.findOne({
          $and: [{ 'participants.userId': senderId }, { 'participants.userId': receiverId }],
        });

        if (!conversation) {
          conversation = await Conversation.create({
            participants: [{ userId: senderId }, { userId: receiverId }],
          });
        }

        // Create message
        const chatMessage = await Chat.create({
          conversationId: conversation._id,
          senderId,
          receiverId,
          message,
          messageType,
          attachment,
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
        io.to(receiverId.toString()).emit('newMessage', chatMessage);
        callback({ success: true, data: chatMessage });
      } catch (error) {
        callback({ success: false, message: 'An error occurred while sending the message' });
      }
    });

    socket.on('markAsRead', async (conversationId, callback) => {
      try {
        const conversation = await Conversation.findById(conversationId);
        if (!conversation) {
          return callback({ success: false, message: 'Conversation not found' });
        }

        // Verify user is a participant in this conversation
        const isParticipant = conversation.participants.some(
          (p) => p.userId.toString() === userId.toString()
        );
        if (!isParticipant) {
          return callback({
            success: false,
            message: 'You are not a participant in this conversation',
          });
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

        io.to(userId.toString()).emit('conversationUpdated', conversation);
        callback({ success: true });
      } catch (error) {
        callback({ success: false, message: 'An error occurred while marking messages as read' });
      }
    });

    // Handle mark_read event (matching Flutter client)
    socket.on('mark_read', async (data) => {
      try {
        const { conversationId } = data;
        const conversation = await Conversation.findById(conversationId);
        if (!conversation) return;

        await Chat.updateMany(
          { conversationId, receiverId: userId, isRead: false },
          { isRead: true }
        );

        conversation.participants.forEach((p) => {
          if (p.userId.toString() === userId.toString()) {
            p.unreadCount = 0;
          }
        });
        await conversation.save();

        socket.emit('messages_read', { conversationId });
      } catch (error) {
        console.error('Error marking messages as read:', error);
      }
    });

    // Handle typing events
    socket.on('typing', (data) => {
      const { conversationId } = data;
      socket.to(conversationId).emit('user_typing', { conversationId, userId });
    });

    socket.on('stop_typing', (data) => {
      const { conversationId } = data;
      socket.to(conversationId).emit('user_stop_typing', { conversationId, userId });
    });
  });
};
