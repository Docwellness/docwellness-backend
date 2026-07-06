/**
 * SequenceService - Atomic Sequence Allocation
 * Provides monotonically increasing sequences per conversation
 */

const Counter = require('../models/Counter');
const ChatLogger = require('./ChatLogger');

const { EVENTS } = ChatLogger;

class SequenceService {
  /**
   * Get the next server sequence for a conversation
   * @param {string} conversationId - Conversation ID
   * @param {object} logContext - Logging context
   * @returns {Promise<number>} Next sequence number
   */
  static async getNextSeq(conversationId, logContext = {}) {
    const startTime = Date.now();
    const key = `conv:${conversationId}`;

    try {
      const seq = await Counter.getNextSeq(key);

      ChatLogger.timed(EVENTS.MSG_SEQ_ALLOC, startTime, {
        ...logContext,
        conversation_id: conversationId,
        server_seq: seq,
      });

      return seq;
    } catch (error) {
      ChatLogger.error(EVENTS.ERROR, {
        ...logContext,
        conversation_id: conversationId,
        error,
        operation: 'seq_alloc',
      });
      throw error;
    }
  }

  /**
   * Get current sequence without incrementing
   * @param {string} conversationId - Conversation ID
   * @returns {Promise<number>} Current sequence number
   */
  static async getCurrentSeq(conversationId) {
    const key = `conv:${conversationId}`;
    return Counter.getCurrentSeq(key);
  }
}

module.exports = SequenceService;
