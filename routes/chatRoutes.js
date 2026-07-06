const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chatController');
const authMiddleware = require('../middlewares/auth');
const upload = require('../middlewares/upload');

router.use(authMiddleware);

// Get or create a conversation with a participant (must be before :id routes)
router.post('/conversations/get-or-create', chatController.getOrCreateConversation);

// Get all conversations for the logged-in user
router.get('/conversations', chatController.getConversations);

// Get messages for a specific conversation
router.get('/conversations/:id/messages', chatController.getMessages);

// Send a new message
router.post('/message/:receiverId', upload.single('image'), chatController.sendMessage);

// Route to upload chat image
// router.post('/upload-image', upload.single('image'), chatController.uploadChatImage);

// Mark all messages in a conversation as read
router.post('/conversations/:id/read', chatController.markAsRead);

module.exports = router;
