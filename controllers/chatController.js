const Conversation = require('../models/Conversation');
const Chat = require('../models/Chat');
const User = require('../models/User');
const CustomFoodRequest = require('../models/CustomFoodRequest');
const config = require('../config/environment');
const cloudinary = require('../config/cloudinary');
const fs = require('fs/promises');
const { getChatIO } = require('../chat');
const { ConversationV1, MessageV1 } = require('../chat/models');
const Notification = require('../models/Notification');

// Chat Controller Version: 2.3.0
// Last Updated: 2026-01-22
// Improvements: Merged V1 conversations with meal logs into main conversation list

// Get all conversations for the logged-in user
exports.getConversations = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const userRole = req.user.role; // 'patient' or 'dietician'

    // Performance optimization: Added lean() for faster query execution
    const conversations = await Conversation.find({
      'participants.userId': userId,
    })
      .populate('participants.userId', 'profile.fullName profile.avatarUrl role isOnline lastSeen')
      .sort({ lastMessageAt: -1 })
      .lean();

    // Also get V1 conversations (for meal logs)
    const v1Conversations = await ConversationV1.find({
      'participants.userId': userId,
    }).lean();

    // Get user info for V1 conversations
    const v1UserIds = new Set();
    v1Conversations.forEach((conv) => {
      conv.participants.forEach((p) => {
        if (String(p.userId) !== String(userId)) {
          v1UserIds.add(String(p.userId));
        }
      });
    });

    const v1Users = await User.find({ _id: { $in: Array.from(v1UserIds) } })
      .select('profile.fullName profile.avatarUrl role isOnline lastSeen')
      .lean();
    const v1UserMap = {};
    v1Users.forEach((u) => {
      v1UserMap[String(u._id)] = u;
    });

    // Build a map of V1 unread counts by other-user-id
    // V1 is the active chat system, so its unreadCount is the source of truth
    const v1UnreadByOtherUser = {};
    v1Conversations.forEach((conv) => {
      const me = conv.participants.find((p) => String(p.userId) === String(userId));
      const other = conv.participants.find((p) => String(p.userId) !== String(userId));
      if (me && other) {
        v1UnreadByOtherUser[String(other.userId)] = me.unreadCount || 0;
      }
    });

    // Transform conversations into frontend-friendly format
    const data = conversations.map((conv) => {
      const participants = conv.participants || [];

      // Find current user's participation (to get unreadCount)
      const me = participants.find((p) => String(p.userId?._id) === String(userId));

      // Find the other user (different role than current user)
      const other = participants.find(
        (p) => p.userId && p.userId.role && p.userId.role !== userRole
      );

      // Use V1 unread count if available (active system), else fall back to legacy
      const otherUserId = other?.userId?._id ? String(other.userId._id) : null;
      const v1Unread = otherUserId != null ? v1UnreadByOtherUser[otherUserId] : undefined;
      const unreadCount = v1Unread !== undefined ? v1Unread : (me?.unreadCount || 0);

      return {
        id: conv._id,
        image: other?.userId?.profile?.avatarUrl || null,
        name: other?.userId?.profile?.fullName || 'Unknown',
        message: conv.lastMessage || '',
        time: conv.lastMessageAt || conv.createdAt,
        count: unreadCount,
        isOnline: other?.userId?.isOnline || false,
        source: 'legacy',
      };
    });

    // Add V1 conversations that don't already exist in legacy
    const existingOtherUserIds = new Set(
      data
        .map((d) => {
          const conv = conversations.find((c) => String(c._id) === String(d.id));
          if (!conv) return null;
          const other = conv.participants.find((p) => String(p.userId?._id) !== String(userId));
          return other?.userId?._id ? String(other.userId._id) : null;
        })
        .filter(Boolean)
    );

    for (const v1Conv of v1Conversations) {
      const otherParticipant = v1Conv.participants.find((p) => String(p.userId) !== String(userId));
      const otherUserId = otherParticipant ? String(otherParticipant.userId) : null;

      // Skip if already have a legacy conversation with this user
      if (otherUserId && existingOtherUserIds.has(otherUserId)) {
        continue;
      }

      const otherUser = otherUserId ? v1UserMap[otherUserId] : null;
      const meV1 = v1Conv.participants.find((p) => String(p.userId) === String(userId));

      data.push({
        id: v1Conv._id,
        image: otherUser?.profile?.avatarUrl || null,
        name: otherUser?.profile?.fullName || 'Unknown',
        message: v1Conv.lastMessage?.content || '',
        time: v1Conv.lastMessage?.createdAt || v1Conv.updatedAt || v1Conv.createdAt,
        count: meV1?.unreadCount || 0,
        isOnline: otherUser?.isOnline || false,
        source: 'v1',
      });
    }

    // Sort by time descending
    data.sort((a, b) => new Date(b.time) - new Date(a.time));

    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// Get messages for a specific conversation
exports.getMessages = async (req, res, next) => {
  try {
    // Try both param names - :id and :conversationId
    const conversationId = req.params.conversationId || req.params.id;
    const userId = req.user._id;
    const userRole = req.user.role; // 'patient' or 'dietician'

    console.log('[GET_MESSAGES] Request:', {
      conversationId,
      userId: String(userId),
      userRole,
      params: req.params,
    });

    // 1. First try to find in legacy Conversation model
    let conversation = await Conversation.findById(conversationId);
    let isV1Conversation = false;

    // 2. If not found in legacy, try V1
    if (!conversation) {
      const v1Conv = await ConversationV1.findById(conversationId);
      if (v1Conv) {
        isV1Conversation = true;
        conversation = {
          _id: v1Conv._id,
          participants: v1Conv.participants.map((p) => ({ userId: p.userId })),
        };
      }
    }

    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: 'Conversation not found',
      });
    }

    console.log(
      '[GET_MESSAGES] Found conversation:',
      conversation._id,
      isV1Conversation ? '(V1)' : '(legacy)'
    );

    // 2. Check if current user is a participant
    const isParticipant = conversation.participants.some(
      (p) => String(p.userId) === String(userId)
    );

    if (!isParticipant) {
      return res.status(403).json({
        success: false,
        message: 'You are not a participant in this conversation',
      });
    }

    let messages = [];
    const oppositeRole = userRole === 'patient' ? 'dietician' : 'patient';

    if (isV1Conversation) {
      // Get messages from V1 MessageV1 model
      const v1Messages = await MessageV1.find({ conversationId: conversation._id })
        .sort({ createdAt: -1 })
        .lean();

      console.log('[GET_MESSAGES] Found', v1Messages.length, 'V1 messages');

      messages = v1Messages.map((m) => {
        const isCurrentUserSender = String(m.senderId) === String(userId);
        const senderRole = isCurrentUserSender ? userRole : oppositeRole;
        const receiverRole = isCurrentUserSender ? oppositeRole : userRole;

        // For custom_food messages, merge customFoodData into metadata
        let metadata = m.metadata || null;
        if (m.type === 'custom_food' && m.customFoodData) {
          metadata = {
            ...(metadata || {}),
            foodName: m.customFoodData.foodName,
            description: m.customFoodData.description,
            image: m.customFoodData.image,
            imageUrl: m.customFoodData.image,
            calories: m.customFoodData.calories,
            protein: m.customFoodData.protein,
            carbs: m.customFoodData.carbs,
            fat: m.customFoodData.fat,
            status: m.customFoodData.status || 'pending',
            action: m.customFoodData.status || 'pending',
            customFoodRequestId: m.customFoodData.customFoodRequestId
              ? String(m.customFoodData.customFoodRequestId)
              : null,
          };
        }

        return {
          id: m._id,
          senderId: m.senderId,
          receiverId: null,
          message: m.content,
          messageType: m.type === 'meal_log' ? 'meal_log' : m.type || 'text',
          attachment: m.attachment || null,
          description: null,
          metadata,
          customFoodData: m.customFoodData || null,
          isRead: true,
          conversationId: m.conversationId,
          createdAt: m.createdAt,
          updatedAt: m.updatedAt,
          replyTo: null,
          senderRole,
          receiverRole,
          isMe: isCurrentUserSender,
        };
      });
    } else {
      // Get messages from legacy Chat model
      const rawMessages = await Chat.find({ conversationId })
        .populate({
          path: 'replyTo',
          select: 'message senderId messageType',
        })
        .sort({ createdAt: -1 })
        .lean();

      console.log('[GET_MESSAGES] Found', rawMessages.length, 'legacy messages');

      // Collect custom food request IDs to batch-fetch their statuses
      const customFoodRequestIds = rawMessages
        .filter((m) => m.messageType === 'custom_food' && m.metadata?.customFoodRequestId)
        .map((m) => m.metadata.customFoodRequestId);

      let customFoodStatuses = {};
      if (customFoodRequestIds.length > 0) {
        try {
          const requests = await CustomFoodRequest.find(
            { _id: { $in: customFoodRequestIds } },
            { _id: 1, status: 1 }
          ).lean();
          requests.forEach((r) => {
            // Map title-case DB status to lowercase for frontend
            const s =
              r.status === 'Accepted'
                ? 'approved'
                : r.status === 'Rejected'
                  ? 'rejected'
                  : 'pending';
            customFoodStatuses[String(r._id)] = s;
          });
        } catch (err) {
          console.error('Failed to fetch custom food statuses:', err.message);
        }
      }

      messages = rawMessages.map((m) => {
        const isCurrentUserSender = String(m.senderId) === String(userId);
        const senderRole = isCurrentUserSender ? userRole : oppositeRole;
        const receiverRole = isCurrentUserSender ? oppositeRole : userRole;

        // Enrich custom food messages with actual status from CustomFoodRequest
        let metadata = m.metadata ? { ...m.metadata } : null;
        if (m.messageType === 'custom_food' && metadata?.customFoodRequestId) {
          const reqId = String(metadata.customFoodRequestId);
          const actualStatus = customFoodStatuses[reqId] || 'pending';
          metadata.status = actualStatus;
          metadata.action = actualStatus;
        }

        return {
          id: m._id,
          senderId: m.senderId,
          receiverId: m.receiverId,
          message: m.message,
          messageType: m.messageType,
          attachment: m.attachment,
          description: m.description || null,
          metadata: metadata,
          isRead: m.isRead,
          conversationId: m.conversationId,
          createdAt: m.createdAt,
          updatedAt: m.updatedAt,
          replyTo: m.replyTo
            ? {
              id: m.replyTo._id,
              message: m.replyTo.message,
              senderId: m.replyTo.senderId,
              messageType: m.replyTo.messageType,
            }
            : null,
          senderRole,
          receiverRole,
          isMe: isCurrentUserSender,
        };
      });
    }

    return res.status(200).json({
      success: true,
      data: messages,
    });
  } catch (error) {
    next(error);
  }
};

// Helper function to check if a user is authorized to access a conversation
const isAuthorizedForConversation = async (userId, conversationId) => {
  const conversation = await Conversation.findById(conversationId);
  if (!conversation) return false;

  return conversation.participants.some((p) => p.userId.toString() === userId.toString());
};

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

// Updated sendMessage to validate roles and increment unread counts
exports.sendMessage = async (req, res, next) => {
  try {
    const { message, replyTo, receiverId: bodyReceiverId, messageType: bodyMessageType, metadata } = req.body;
    const { receiverId: paramReceiverId } = req.params;
    const senderId = req.user._id;
    const senderRole = req.user.role;

    let attachmentUrl = null;
    let messageType = bodyMessageType || 'text';
    let receiverId = paramReceiverId || bodyReceiverId;

    if (req.file) {
      const result = await cloudinary.uploader.upload(req.file.path, {
        folder: 'docwellness/chat',
      });
      attachmentUrl = result.secure_url;
      messageType = 'image';

      await fs.unlink(req.file.path).catch(() => { });
    }

    if (!message && !attachmentUrl) {
      return res.status(400).json({ success: false, message: 'Message or image is required' });
    }

    // Patients automatically chat with the default dietician
    if (senderRole === 'patient') {
      receiverId = config.defaultDieticianId;
    } else if (senderRole === 'dietician') {
      // Dieticians must specify which patient to message
      if (!receiverId) {
        return res
          .status(400)
          .json({ success: false, message: 'receiverId is required for dietician messages' });
      }
    } else {
      return res.status(403).json({ success: false, message: 'Invalid user role' });
    }

    // Validate roles and assignment
    const isAssigned = await verifyAssignment(senderId, receiverId);
    if (!isAssigned) {
      return res
        .status(403)
        .json({ success: false, message: 'You are not authorized to send messages to this user' });
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
      message: message || (messageType === 'image' ? '' : ''),
      messageType,
      attachment: attachmentUrl,
      replyTo: replyTo || null,
      metadata: metadata || null,
    });

    const populatedMessage = await Chat.findById(chatMessage._id).populate({
      path: 'replyTo',
      select: 'message senderId messageType',
    });

    // Update conversation
    conversation.lastMessage = messageType === 'image' ? '📷 Photo' : message;
    conversation.lastMessageAt = new Date();
    conversation.lastMessageSender = senderId;
    conversation.participants.forEach((p) => {
      if (p.userId.toString() !== senderId.toString()) {
        p.unreadCount += 1;
      }
    });
    await conversation.save();

    // Emit real-time message to receiver via Socket.IO
    try {
      const io = getChatIO();
      if (io) {
        const messagePayload = {
          id: populatedMessage._id,
          conversationId: conversation._id,
          senderId: senderId,
          receiverId: receiverId,
          content: message || '',
          type: messageType,
          attachment: attachmentUrl,
          replyTo: populatedMessage.replyTo,
          createdAt: populatedMessage.createdAt,
          senderRole: senderRole,
          ...(messageType === 'confession_box' && metadata ? { confessionData: metadata } : {}),
          ...(messageType === 'allergy_report' && metadata ? { allergyReportData: metadata } : {}),
          ...(messageType === 'doctor_recommendation' && metadata ? { recommendationData: metadata } : {}),
        };

        // Emit to receiver's personal room only.
        // NOTE: Do NOT also emit to `conv:<id>` room — the receiver joins both
        // their personal room (on auth) and the conv room (when they open the
        // chat), so emitting to both delivers the same msg.new twice and the
        // client sees duplicates.
        io.to(receiverId.toString()).emit('msg.new', { message: messagePayload });

        console.log(`📤 Message broadcast to ${receiverId}`);
      }
    } catch (socketError) {
      console.error('Socket broadcast error:', socketError);
      // Don't fail the request if socket broadcast fails
    }

    // Create a notification for the receiver
    try {
      const sender = await User.findById(senderId).select('profile.fullName role').lean();
      const senderName =
        sender?.profile?.fullName || (senderRole === 'patient' ? 'Patient' : 'Doctor');
      const notifTitle = `New message from ${senderName}`;
      const notifMessage =
        messageType === 'image' ? '📷 Sent a photo'
          : messageType === 'confession_box' ? '🍕 Confession Box'
            : messageType === 'allergy_report' ? '⚠️ Allergy Report'
              : messageType === 'doctor_recommendation' ? '💊 Sent a recommendation'
                : (message || '').slice(0, 100);

      const notif = await Notification.create({
        userId: receiverId,
        title: notifTitle,
        message: notifMessage,
        type: 'chat',
        referenceId: conversation._id,
        referenceModel: 'Chat',
      });

      // Emit real-time notification to receiver
      const ioRef = getChatIO();
      if (ioRef) {
        ioRef.to(receiverId.toString()).emit('notification.new', {
          id: notif._id,
          title: notif.title,
          message: notif.message,
          type: notif.type,
          referenceId: notif.referenceId?.toString(),
          createdAt: notif.createdAt,
        });
      }
    } catch (notifError) {
      console.error('Notification creation error:', notifError);
    }

    res.status(201).json({ success: true, data: populatedMessage });
  } catch (error) {
    next(error);
  }
};

// Upload image for chat (returns Cloudinary URL)
exports.uploadChatImage = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Image file is required' });
    }

    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: 'docwellness/chat',
    });

    await fs.unlink(req.file.path).catch(() => { });

    res.status(200).json({
      success: true,
      url: result.secure_url,
    });
  } catch (error) {
    next(error);
  }
};

// Mark all messages in a conversation as read
exports.markAsRead = async (req, res, next) => {
  try {
    // Support both :id and :conversationId param names
    const id = req.params.id || req.params.conversationId;
    const userId = req.user._id;

    // Try legacy Conversation first
    const conversation = await Conversation.findById(id);
    if (conversation) {
      const isParticipant = conversation.participants.some(
        (p) => p.userId.toString() === userId.toString()
      );
      if (!isParticipant) {
        return res
          .status(403)
          .json({ success: false, message: 'You are not a participant in this conversation' });
      }

      // Mark legacy messages as read
      await Chat.updateMany(
        { conversationId: id, receiverId: userId, isRead: false },
        { isRead: true }
      );

      // Reset legacy unread count
      conversation.participants.forEach((p) => {
        if (p.userId.toString() === userId.toString()) {
          p.unreadCount = 0;
        }
      });
      await conversation.save();

      // Also reset V1 unread count — match by participant user IDs (not by legacy _id)
      const participantUserIds = conversation.participants.map((p) => p.userId);
      await ConversationV1.updateOne(
        { 'participants.userId': { $all: participantUserIds } },
        { $set: { 'participants.$[me].unreadCount': 0 } },
        { arrayFilters: [{ 'me.userId': userId }] }
      );
    } else {
      // No legacy conversation — try V1 directly
      const v1Conv = await ConversationV1.findById(id);
      if (!v1Conv) {
        return res.status(404).json({ success: false, message: 'Conversation not found' });
      }

      // Reset V1 unread count by _id
      await ConversationV1.updateOne(
        { _id: id, 'participants.userId': userId },
        { $set: { 'participants.$.unreadCount': 0 } }
      );
    }

    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};

// List patients with active or finalized diet plans, including chat metadata
exports.listChatPatientsForDietician = async (req, res, next) => {
  try {
    const dieticianId = req.user._id;
    const { role } = req.user;

    // Auth check
    if (role !== 'dietician') {
      return res.status(403).json({
        success: false,
        message: 'Only dieticians can access this endpoint',
      });
    }

    // Pagination
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limitParsed = parseInt(req.query.limit, 10);
    const limit = Math.min(Math.max(Number.isNaN(limitParsed) ? 10 : limitParsed, 1), 100);
    const skip = (page - 1) * limit;

    // Find DietPlanRequests for this dietician (active or finalized)
    const { DietPlanRequest } = require('../models');
    const filter = {
      dieticianId,
      $or: [
        // Active: Paid + hasActivePlan + not completed
        {
          status: 'Paid',
          hasActivePlan: true,
          completedAt: null,
        },
        // Finalized: completed
        {
          completedAt: { $ne: null },
        },
      ],
    };

    const query = DietPlanRequest.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate(
        'patient',
        [
          'profile.fullName',
          'profile.imageUrl',
          'profile.gender',
          'healthProfile.weight',
          'healthProfile.height',
          'healthProfile.bmi',
        ].join(' ')
      );

    const [total, requests] = await Promise.all([DietPlanRequest.countDocuments(filter), query]);

    // Extract patient IDs
    const patientIds = requests
      .map((r) => r.patient?._id)
      .filter((id) => id !== null && id !== undefined);

    // Query conversations for chat metadata
    let conversationMap = {};
    if (patientIds.length > 0) {
      const conversations = await Conversation.find({
        $and: [
          { 'participants.userId': dieticianId },
          { 'participants.userId': { $in: patientIds } },
        ],
      }).lean();

      conversations.forEach((conv) => {
        const patientParticipant = conv.participants.find((p) => !p.userId.equals(dieticianId));

        if (patientParticipant) {
          const patientIdStr = patientParticipant.userId.toString();
          conversationMap[patientIdStr] = {
            conversationId: conv._id.toString(),
            lastMessage: conv.lastMessage || null,
            lastMessageAt: conv.lastMessageAt || null,
            unreadCount: patientParticipant.unreadCount ?? 0,
          };
        }
      });
    }

    // Build response
    const data = requests.map((request) => {
      const patient = request.patient || {};
      const profile = patient.profile || {};
      const healthProfile = patient.healthProfile || {};
      const patientIdStr = patient._id?.toString() || null;

      // Determine plan status
      let planStatus = 'active';
      if (request.completedAt !== null && request.completedAt !== undefined) {
        planStatus = 'finalized';
      }

      // Get chat metadata or defaults
      const chatData = conversationMap[patientIdStr] || {
        conversationId: null,
        lastMessage: null,
        lastMessageAt: null,
        unreadCount: 0,
      };

      return {
        patientId: patientIdStr,
        fullName: profile.fullName || null,
        avatarUrl: profile.imageUrl || null,
        planStatus,
        currentWeight: request.currentWeight ?? null,
        totalKgLost: request.totalKgLost ?? null,
        ...chatData,
      };
    });

    return res.status(200).json({
      success: true,
      data,
      pagination: {
        page,
        limit,
        total,
        hasMore: skip + requests.length < total,
      },
    });
  } catch (error) {
    next(error);
  }
};

// Get or create a conversation with a participant (for patients, auto-assigns to default dietician)
exports.getOrCreateConversation = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const userRole = req.user.role;
    let { participantId } = req.body;

    // For patients, always create conversation with default dietician
    if (userRole === 'patient') {
      participantId = config.defaultDieticianId;
    }

    if (!participantId) {
      return res.status(400).json({
        success: false,
        message: 'participantId is required',
      });
    }

    // Check if conversation already exists
    let conversation = await Conversation.findOne({
      $and: [{ 'participants.userId': userId }, { 'participants.userId': participantId }],
    }).populate('participants.userId', 'profile.fullName profile.avatarUrl role isOnline');

    if (!conversation) {
      // Create new conversation
      conversation = await Conversation.create({
        participants: [
          { userId: userId, unreadCount: 0 },
          { userId: participantId, unreadCount: 0 },
        ],
      });

      // Populate after creation
      conversation = await Conversation.findById(conversation._id).populate(
        'participants.userId',
        'profile.fullName profile.avatarUrl role isOnline'
      );
    }

    // Find the other participant for response
    const otherParticipant = conversation.participants.find(
      (p) => p.userId._id.toString() !== userId.toString()
    );

    const responseData = {
      id: conversation._id,
      participants: conversation.participants.map((p) => ({
        id: p.userId._id,
        name: p.userId.profile?.fullName || 'Unknown',
        profileImage: p.userId.profile?.avatarUrl || null,
        role: p.userId.role,
        isOnline: p.userId.isOnline || false,
      })),
      otherUser: otherParticipant
        ? {
          id: otherParticipant.userId._id,
          name: otherParticipant.userId.profile?.fullName || 'Dietician',
          profileImage: otherParticipant.userId.profile?.avatarUrl || null,
          role: otherParticipant.userId.role,
          isOnline: otherParticipant.userId.isOnline || false,
        }
        : null,
      lastMessage: conversation.lastMessage || null,
      lastMessageAt: conversation.lastMessageAt || conversation.createdAt,
    };

    res.status(200).json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    next(error);
  }
};

// Send a doctor note to a patient (creates a chat message of type doctor_note)
exports.sendDoctorNote = async (req, res, next) => {
  try {
    const dieticianId = req.user._id;
    const { patientId } = req.params;
    const { noteDate, noteContent } = req.body;

    if (!noteContent || !noteContent.trim()) {
      return res.status(400).json({ success: false, message: 'Note content is required' });
    }

    // Verify the patient exists
    const patient = await User.findById(patientId);
    if (!patient || patient.role !== 'patient') {
      return res.status(404).json({ success: false, message: 'Patient not found' });
    }

    // Get or create conversation
    let conversation = await Conversation.findOne({
      $and: [{ 'participants.userId': dieticianId }, { 'participants.userId': patientId }],
    });

    if (!conversation) {
      conversation = await Conversation.create({
        participants: [{ userId: dieticianId }, { userId: patientId }],
      });
    }

    // Create chat message
    const chatMessage = await Chat.create({
      conversationId: conversation._id,
      senderId: dieticianId,
      receiverId: patientId,
      message: noteContent.trim(),
      messageType: 'doctor_note',
      metadata: {
        noteDate: noteDate ? new Date(noteDate) : new Date(),
      },
    });

    // Update conversation
    conversation.lastMessage = `📝 Doctor's Note`;
    conversation.lastMessageAt = new Date();
    conversation.lastMessageSender = dieticianId;
    conversation.participants.forEach((p) => {
      if (p.userId.toString() !== dieticianId.toString()) {
        p.unreadCount += 1;
      }
    });
    await conversation.save();

    // Emit real-time message via Socket.IO
    try {
      const io = getChatIO();
      if (io) {
        const messagePayload = {
          id: chatMessage._id,
          conversationId: conversation._id,
          senderId: dieticianId,
          receiverId: patientId,
          content: noteContent.trim(),
          type: 'doctor_note',
          messageType: 'doctor_note',
          metadata: {
            noteDate: noteDate ? new Date(noteDate) : new Date(),
          },
          createdAt: chatMessage.createdAt,
          senderRole: 'dietician',
        };

        io.to(patientId.toString()).emit('msg.new', { message: messagePayload });
        io.to(`conv:${conversation._id.toString()}`).emit('msg.new', { message: messagePayload });

        console.log(`📝 Doctor note sent to patient ${patientId}`);
      }
    } catch (socketError) {
      console.error('Socket broadcast error (doctor note):', socketError);
    }

    res.status(201).json({
      success: true,
      data: {
        id: chatMessage._id,
        noteDate: noteDate ? new Date(noteDate) : new Date(),
        noteContent: noteContent.trim(),
        createdAt: chatMessage.createdAt,
      },
    });
  } catch (error) {
    next(error);
  }
};

// Get doctor notes for a specific patient (dietician route)
exports.getDoctorNotes = async (req, res, next) => {
  try {
    const dieticianId = req.user._id;
    const { patientId } = req.params;

    const notes = await Chat.find({
      senderId: dieticianId,
      receiverId: patientId,
      messageType: 'doctor_note',
    })
      .sort({ createdAt: -1 })
      .lean();

    const data = notes.map((n) => ({
      id: n._id,
      noteDate: n.metadata?.noteDate || n.createdAt,
      noteContent: n.message,
      createdAt: n.createdAt,
    }));

    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// Get doctor notes for the authenticated patient (patient route)
exports.getPatientDoctorNotes = async (req, res, next) => {
  try {
    const patientId = req.user._id;

    const notes = await Chat.find({
      receiverId: patientId,
      messageType: 'doctor_note',
    })
      .sort({ createdAt: -1 })
      .populate('senderId', 'profile.fullName profile.avatarUrl')
      .lean();

    const data = notes.map((n) => ({
      id: n._id,
      noteDate: n.metadata?.noteDate || n.createdAt,
      noteContent: n.message,
      doctorName: n.senderId?.profile?.fullName || 'Your Doctor',
      createdAt: n.createdAt,
    }));

    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// Get assigned dietician for patient (always returns default dietician)
exports.getAssignedDietician = async (req, res, next) => {
  try {
    const dietician = await User.findById(config.defaultDieticianId).select(
      'profile.fullName profile.avatarUrl isOnline role'
    );

    if (!dietician) {
      return res.status(404).json({
        success: false,
        message: 'Assigned dietician not found',
      });
    }

    res.status(200).json({
      success: true,
      data: {
        id: dietician._id,
        name: dietician.profile?.fullName || 'Your Dietician',
        profileImage: dietician.profile?.avatarUrl || null,
        role: dietician.role,
        isOnline: dietician.isOnline || false,
      },
    });
  } catch (error) {
    next(error);
  }
};
