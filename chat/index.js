/**
 * Chat Module Index
 * Exports all chat-related components
 */

const chatRoutes = require('./routes');
const { initializeChatSocketV1, getChatIO } = require('./socket');
const MealLogSyncService = require('./services/MealLogSyncService');
const ChatLogger = require('./services/ChatLogger');

module.exports = {
  chatRoutes,
  initializeChatSocketV1,
  getChatIO,
  MealLogSyncService,
  ChatLogger,
};
