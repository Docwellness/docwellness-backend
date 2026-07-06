/**
 * MealLogSyncService - Meal Log to Chat Integration
 * Syncs meal logs to the LEGACY chat system (Chat + Conversation models)
 * so they appear in the same conversation patients use
 */

const mongoose = require('mongoose');
const { ProcessedEvent } = require('../models');
const { Chat, Conversation } = require('../../models'); // Use legacy models!
const ChatLogger = require('./ChatLogger');
const config = require('../../config/environment');

const { EVENTS } = ChatLogger;

// Reference to Socket.IO instance (set by socket initializer)
let ioInstance = null;

/**
 * Set the Socket.IO instance for real-time updates
 * @param {object} io - Socket.IO server instance
 */
function setIO(io) {
  ioInstance = io;
}

/**
 * Generate a unique event ID
 * @param {string} type - Event type
 * @param {string} entityId - Entity ID
 * @param {number} version - Version
 * @returns {string} Event ID
 */
function generateEventId(type, entityId, version) {
  return `${type}:${entityId}:${version}:${Date.now()}`;
}

class MealLogSyncService {
  /**
   * Ingest a meal log event from internal hook or webhook
   * @param {object} event - Event data
   * @param {string} event.event_type - Type of event (meal_log.created, meal_log.updated, etc.)
   * @param {string} event.event_id - Unique event ID (optional, will be generated if not provided)
   * @param {Date} event.occurred_at - When event occurred
   * @param {string} event.conversation_id - Conversation ID (optional, will be derived)
   * @param {string} event.meal_log_id - Meal log ID
   * @param {number} event.meal_log_version - Version of the meal log
   * @param {string} event.actor_user_id - User who triggered the event
   * @param {object} event.snapshot - Current meal log snapshot
   * @param {object} logContext - Logging context
   * @returns {Promise<object>} Processing result
   */
  static async ingestFromInternal(event, logContext = {}) {
    const startTime = Date.now();
    const {
      event_type,
      event_id = generateEventId(event_type, event.meal_log_id, event.meal_log_version),
      occurred_at = new Date(),
      conversation_id,
      meal_log_id,
      meal_log_version,
      actor_user_id,
      snapshot,
    } = event;

    ChatLogger.info(EVENTS.MEAL_LOG_EVENT_IN, {
      ...logContext,
      event_id,
      event_type,
      meal_log_id,
      meal_log_version,
      actor_user_id,
    });

    // Check for duplicate event
    const existingEvent = await ProcessedEvent.findOne({ eventId: event_id });
    if (existingEvent) {
      ChatLogger.info(EVENTS.MEAL_LOG_DEDUP_HIT, {
        ...logContext,
        event_id,
        meal_log_id,
        reason: 'event_exists',
      });
      return { status: 'skipped', reason: 'duplicate_event' };
    }

    // Check version (skip if older version already processed)
    const lastProcessed = await ProcessedEvent.findOne({
      entityId: new mongoose.Types.ObjectId(meal_log_id),
      entityVersion: { $gte: meal_log_version },
      status: 'processed',
    });

    if (lastProcessed) {
      ChatLogger.info(EVENTS.MEAL_LOG_DEDUP_HIT, {
        ...logContext,
        event_id,
        meal_log_id,
        meal_log_version,
        reason: 'version_stale',
        existing_version: lastProcessed.entityVersion,
      });

      await ProcessedEvent.create({
        eventId: event_id,
        eventType: event_type,
        entityId: new mongoose.Types.ObjectId(meal_log_id),
        entityVersion: meal_log_version,
        actorUserId: new mongoose.Types.ObjectId(actor_user_id),
        status: 'skipped',
        error: 'version_stale',
      });

      return { status: 'skipped', reason: 'version_stale' };
    }

    try {
      // Get or create LEGACY conversation (same one used by patient chat)
      const dieticianId = config.defaultDieticianId;
      let conversation = await Conversation.findOne({
        $and: [{ 'participants.userId': actor_user_id }, { 'participants.userId': dieticianId }],
      });

      if (!conversation) {
        conversation = await Conversation.create({
          participants: [
            { userId: actor_user_id, unreadCount: 0 },
            { userId: dieticianId, unreadCount: 0 },
          ],
        });
        ChatLogger.info(EVENTS.CONV_CREATED, {
          ...logContext,
          conversation_id: conversation._id,
          participants: [actor_user_id, dieticianId],
        });
      }

      const convId = conversation._id;
      let messageId = null;
      let action = 'unknown';

      // Strategy A: In-place update existing meal_log Chat message
      const existingMessage = await Chat.findOne({
        'metadata.mealLogId': new mongoose.Types.ObjectId(meal_log_id),
        messageType: 'meal_log',
      });

      if (existingMessage) {
        // Update existing message in-place
        existingMessage.message = MealLogSyncService.formatMealLogMessage(event_type, snapshot);
        existingMessage.metadata = {
          mealLogId: new mongoose.Types.ObjectId(meal_log_id),
          action: MealLogSyncService.mapEventToAction(event_type),
          itemName: snapshot?.mealType || snapshot?.itemName || 'Meal',
          calories: snapshot?.calories || snapshot?.caloriesConsumed || 0,
          servings: snapshot?.servings || 1,
          servingTime: snapshot?.servingTime || snapshot?.mealType,
          totalConsumed: snapshot?.totalCalories || snapshot?.totalConsumed || 0,
          totalPlanned: snapshot?.plannedCalories || snapshot?.totalPlanned || 2000,
        };
        await existingMessage.save();

        messageId = existingMessage._id;
        action = 'updated_in_place';

        // Emit msg.updated event via Socket.IO to legacy event format
        if (ioInstance) {
          const msgData = {
            id: existingMessage._id,
            senderId: existingMessage.senderId,
            receiverId: existingMessage.receiverId,
            message: existingMessage.message,
            messageType: existingMessage.messageType,
            metadata: existingMessage.metadata,
            conversationId: convId,
            createdAt: existingMessage.createdAt,
            updatedAt: new Date(),
          };

          // Emit to both participants
          ioInstance.to(actor_user_id.toString()).emit('msg.updated', msgData);
          ioInstance.to(dieticianId.toString()).emit('msg.updated', msgData);

          ChatLogger.info(EVENTS.MSG_UPDATED_FANOUT, {
            ...logContext,
            message_id: existingMessage._id,
            conversation_id: convId,
            participant_count: 2,
          });
        }
      } else {
        // Strategy B: Create new meal_log Chat message
        const newMessage = await Chat.create({
          senderId: actor_user_id,
          receiverId: dieticianId,
          conversationId: convId,
          message: MealLogSyncService.formatMealLogMessage(event_type, snapshot),
          messageType: 'meal_log',
          metadata: {
            mealLogId: new mongoose.Types.ObjectId(meal_log_id),
            action: MealLogSyncService.mapEventToAction(event_type),
            itemName: snapshot?.mealType || snapshot?.itemName || 'Meal',
            calories: snapshot?.calories || snapshot?.caloriesConsumed || 0,
            servings: snapshot?.servings || 1,
            servingTime: snapshot?.servingTime || snapshot?.mealType,
            totalConsumed: snapshot?.totalCalories || snapshot?.totalConsumed || 0,
            totalPlanned: snapshot?.plannedCalories || snapshot?.totalPlanned || 2000,
          },
          isRead: false,
        });

        messageId = newMessage._id;
        action = 'created_new';

        // Update conversation lastMessage
        await Conversation.findByIdAndUpdate(
          convId,
          {
            lastMessage: newMessage.message,
            lastMessageAt: new Date(),
            $inc: { 'participants.$[elem].unreadCount': 1 },
          },
          {
            arrayFilters: [{ 'elem.userId': dieticianId }],
          }
        );

        // Fanout new message to both participants
        if (ioInstance) {
          const msgData = {
            id: newMessage._id,
            senderId: newMessage.senderId,
            receiverId: newMessage.receiverId,
            message: newMessage.message,
            messageType: newMessage.messageType,
            metadata: newMessage.metadata,
            conversationId: convId,
            createdAt: newMessage.createdAt,
            senderRole: 'patient',
            receiverRole: 'dietician',
            isMe: false,
          };

          // Emit to dietician (using legacy event format)
          ioInstance.to(dieticianId.toString()).emit('new_message', {
            message: msgData,
            conversationId: convId.toString(),
          });

          // Also emit to patient for their chat view
          ioInstance.to(actor_user_id.toString()).emit('new_message', {
            message: { ...msgData, isMe: true },
            conversationId: convId.toString(),
          });

          ChatLogger.info(EVENTS.MSG_FANOUT, {
            ...logContext,
            message_id: messageId,
            conversation_id: convId,
            receiver_id: dieticianId,
          });
        }
      }

      // Record processed event
      await ProcessedEvent.create({
        eventId: event_id,
        eventType: event_type,
        entityId: new mongoose.Types.ObjectId(meal_log_id),
        entityVersion: meal_log_version,
        conversationId: convId,
        messageId,
        actorUserId: new mongoose.Types.ObjectId(actor_user_id),
        status: 'processed',
      });

      ChatLogger.timed(EVENTS.MEAL_LOG_DEDUP_OK, startTime, {
        ...logContext,
        event_id,
        meal_log_id,
        meal_log_version,
        message_id: messageId,
        action,
      });

      return { status: 'processed', action, messageId };
    } catch (error) {
      // Record failed event
      await ProcessedEvent.create({
        eventId: event_id,
        eventType: event_type,
        entityId: new mongoose.Types.ObjectId(meal_log_id),
        entityVersion: meal_log_version,
        actorUserId: new mongoose.Types.ObjectId(actor_user_id),
        status: 'failed',
        error: error.message,
      });

      ChatLogger.error(EVENTS.ERROR, {
        ...logContext,
        event_id,
        meal_log_id,
        error,
        operation: 'meal_log_ingest',
      });

      throw error;
    }
  }

  /**
   * Format a meal log message content
   * @param {string} eventType - Event type
   * @param {object} snapshot - Meal log snapshot
   * @returns {string} Formatted message
   */
  static formatMealLogMessage(eventType, snapshot) {
    const action = eventType.split('.')[1];
    const mealType = snapshot?.mealType || 'Meal';
    const calories = snapshot?.calories || snapshot?.caloriesConsumed || 0;

    switch (action) {
      case 'created':
        return `Logged ${mealType}: ${calories} cal`;
      case 'updated':
        return `Updated ${mealType}: ${calories} cal`;
      case 'completed':
        return `Completed ${mealType}`;
      case 'deleted':
        return `Removed ${mealType} entry`;
      default:
        return `${mealType} update`;
    }
  }

  /**
   * Map event type to mealLogData action enum value
   * @param {string} eventType - Event type like 'meal_log.created'
   * @returns {string} Action for mealLogData enum ('added', 'updated', 'completed', 'deleted', 'note')
   */
  static mapEventToAction(eventType) {
    const eventAction = eventType.split('.')[1];
    const actionMap = {
      created: 'added',
      updated: 'updated',
      completed: 'completed',
      deleted: 'deleted',
    };
    return actionMap[eventAction] || 'note';
  }
}

// Attach setIO to the class
MealLogSyncService.setIO = setIO;

module.exports = MealLogSyncService;
