/**
 * Chat v1 REST Routes
 * Mount under /api/v1/chat or similar
 */

const express = require('express');
const router = express.Router();

const chatController = require('../controllers');
const {
  requestContext,
  requestLogging,
  idempotencyMiddleware,
  rateLimit,
} = require('../middleware');
const authMiddleware = require('../../middlewares/auth');
const upload = require('../../middlewares/upload');

// Apply middleware to all routes
router.use(requestContext);
router.use(authMiddleware);
router.use(requestLogging);
router.use(rateLimit);

// ==========================================
// Conversation Routes
// ==========================================

/**
 * @route   GET /v1/conversations
 * @desc    Get conversation list with unread counts
 * @query   q (search), limit, cursor
 */
router.get('/conversations', chatController.getConversations);

/**
 * @route   GET /v1/chat/unread-count
 * @desc    Total unread message count across all conversations
 *          (AI_EXECUTION_PLAN.md Phase 5, P5-04). Registered before
 *          '/conversations/:id/messages' etc. is irrelevant here since the
 *          literal path never collides with a param route.
 */
router.get('/unread-count', chatController.getUnreadCount);

/**
 * @route   POST /v1/conversations/direct
 * @desc    Create or get direct conversation
 * @body    participantId (optional for patients)
 */
router.post('/conversations/direct', chatController.createDirectConversation);

/**
 * @route   GET /v1/conversations/:id/messages
 * @desc    Get messages with pagination
 * @query   limit, before_seq, after_seq
 */
router.get('/conversations/:id/messages', chatController.getMessages);

/**
 * @route   GET /v1/conversations/:id/messages/sync
 * @desc    Reconnect sync - catch up on messages after a given serverSeq
 *          (see AI_EXECUTION_PLAN.md Phase 4, P4-07)
 * @query   after_seq, limit
 */
router.get('/conversations/:id/messages/sync', chatController.syncMessages);

/**
 * @route   POST /v1/conversations/:id/messages
 * @desc    Send message (REST fallback)
 * @header  Idempotency-Key (for dedup)
 * @body    client_message_id, type, content, reply_to
 */
router.post(
  '/conversations/:id/messages',
  idempotencyMiddleware,
  upload.single('attachment'),
  chatController.sendMessage
);

/**
 * @route   POST /v1/conversations/:id/read
 * @desc    Mark conversation as read
 * @body    last_read_seq
 */
router.post('/conversations/:id/read', chatController.markRead);

/**
 * @route   GET /v1/conversations/:id/analytics
 * @desc    Get conversation analytics
 */
router.get('/conversations/:id/analytics', chatController.getAnalytics);

// ==========================================
// Message Routes
// ==========================================

/**
 * @route   POST /v1/messages/:id/delivered
 * @desc    Mark message as delivered
 */
router.post('/messages/:id/delivered', chatController.markDelivered);

// ==========================================
// Media Routes
// ==========================================

/**
 * @route   POST /v1/media/presign
 * @desc    Get presigned URL for media upload
 * @body    file_name, content_type
 */
router.post('/media/presign', chatController.presignMedia);

// ==========================================
// Utility Routes
// ==========================================

/**
 * @route   POST /v1/link/preview
 * @desc    Get link preview for URL
 * @body    url
 */
router.post('/link/preview', chatController.getLinkPreview);

// ==========================================
// Integration Routes
// ==========================================

/**
 * @route   POST /v1/integrations/meal-logs/events
 * @desc    Webhook for meal log events
 * @body    event_type, event_id, meal_log_id, meal_log_version, actor_user_id, snapshot
 */
router.post('/integrations/meal-logs/events', chatController.mealLogWebhook);

module.exports = router;
