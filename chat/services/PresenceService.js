/**
 * PresenceService - User Online/Offline Tracking
 * In-memory implementation (non-prod safe) with fallback notes
 *
 * NOTE: For production, replace with Redis-backed implementation
 */

const ChatLogger = require('./ChatLogger');

const { EVENTS } = ChatLogger;

// In-memory store: userId -> { socketId, lastSeen, status }
const onlineUsers = new Map();

// Last seen timestamps for all users
const lastSeenMap = new Map();

class PresenceService {
  /**
   * Mark user as online
   * @param {string} userId - User ID
   * @param {string} socketId - Socket ID
   * @param {object} logContext - Logging context
   */
  static setOnline(userId, socketId, logContext = {}) {
    const userIdStr = userId.toString();

    onlineUsers.set(userIdStr, {
      socketId,
      lastSeen: new Date(),
      status: 'online',
    });

    lastSeenMap.set(userIdStr, new Date());

    ChatLogger.info(EVENTS.PRESENCE_ONLINE, {
      ...logContext,
      user_id: userIdStr,
    });

    return true;
  }

  /**
   * Mark user as offline
   * @param {string} userId - User ID
   * @param {object} logContext - Logging context
   */
  static setOffline(userId, logContext = {}) {
    const userIdStr = userId.toString();

    if (onlineUsers.has(userIdStr)) {
      lastSeenMap.set(userIdStr, new Date());
      onlineUsers.delete(userIdStr);
    }

    ChatLogger.info(EVENTS.PRESENCE_OFFLINE, {
      ...logContext,
      user_id: userIdStr,
    });

    return true;
  }

  /**
   * Check if user is online
   * @param {string} userId - User ID
   * @returns {boolean}
   */
  static isOnline(userId) {
    return onlineUsers.has(userId.toString());
  }

  /**
   * Get user's socket ID if online
   * @param {string} userId - User ID
   * @returns {string|null}
   */
  static getSocketId(userId) {
    const entry = onlineUsers.get(userId.toString());
    return entry ? entry.socketId : null;
  }

  /**
   * Get user's last seen timestamp
   * @param {string} userId - User ID
   * @returns {Date|null}
   */
  static getLastSeen(userId) {
    return lastSeenMap.get(userId.toString()) || null;
  }

  /**
   * Get online status for multiple users
   * @param {string[]} userIds - Array of user IDs
   * @returns {object[]} Array of { userId, isOnline, lastSeen }
   */
  static getBulkStatus(userIds) {
    return userIds.map((userId) => {
      const userIdStr = userId.toString();
      return {
        userId: userIdStr,
        isOnline: onlineUsers.has(userIdStr),
        lastSeen: lastSeenMap.get(userIdStr) || null,
      };
    });
  }

  /**
   * Update user's last activity (heartbeat)
   * @param {string} userId - User ID
   */
  static ping(userId) {
    const userIdStr = userId.toString();
    const entry = onlineUsers.get(userIdStr);

    if (entry) {
      entry.lastSeen = new Date();
      lastSeenMap.set(userIdStr, entry.lastSeen);
    }
  }

  /**
   * Get count of online users
   * @returns {number}
   */
  static getOnlineCount() {
    return onlineUsers.size;
  }

  /**
   * Get all online user IDs
   * @returns {string[]}
   */
  static getAllOnlineUserIds() {
    return Array.from(onlineUsers.keys());
  }

  /**
   * Clean up stale entries (users with no activity for > 2 minutes)
   * Should be called periodically
   */
  static cleanupStale() {
    const staleThreshold = 2 * 60 * 1000; // 2 minutes
    const now = Date.now();

    for (const [userId, entry] of onlineUsers.entries()) {
      if (now - entry.lastSeen.getTime() > staleThreshold) {
        PresenceService.setOffline(userId, { reason: 'stale_cleanup' });
      }
    }
  }
}

// Run cleanup every minute
setInterval(() => {
  PresenceService.cleanupStale();
}, 60 * 1000);

module.exports = PresenceService;
