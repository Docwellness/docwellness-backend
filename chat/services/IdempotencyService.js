/**
 * IdempotencyService - REST API Deduplication
 */

const { IdempotencyKey } = require('../models');

class IdempotencyService {
  /**
   * Check if request with idempotency key already processed
   * @param {string} key - Idempotency key
   * @param {string} userId - User ID
   * @param {string} endpoint - Request endpoint
   * @param {string} method - HTTP method
   * @returns {Promise<object|null>} Stored response or null
   */
  static async checkKey(key, userId, endpoint, method) {
    if (!key) return null;

    const existing = await IdempotencyKey.findOne({
      key,
      userId,
      status: 'completed',
    });

    if (existing) {
      return {
        statusCode: existing.statusCode,
        body: existing.responseBody,
      };
    }

    // Try to acquire lock
    try {
      await IdempotencyKey.create({
        key,
        userId,
        endpoint,
        method,
        status: 'pending',
        lockedAt: new Date(),
      });
      return null;
    } catch (error) {
      // Key exists but not completed - check if stale lock
      if (error.code === 11000) {
        const pending = await IdempotencyKey.findOne({
          key,
          userId,
          status: 'pending',
        });

        if (pending) {
          const lockAge = Date.now() - pending.lockedAt.getTime();
          if (lockAge > 30000) {
            // 30 second timeout
            // Stale lock, allow retry
            await IdempotencyKey.deleteOne({ _id: pending._id });
            return null;
          }
          // Request in progress
          throw new Error('Request in progress');
        }
      }
      throw error;
    }
  }

  /**
   * Store response for idempotency key
   * @param {string} key - Idempotency key
   * @param {string} userId - User ID
   * @param {number} statusCode - Response status code
   * @param {object} body - Response body
   */
  static async storeResponse(key, userId, statusCode, body) {
    if (!key) return;

    await IdempotencyKey.findOneAndUpdate(
      { key, userId },
      {
        statusCode,
        responseBody: body,
        status: 'completed',
        completedAt: new Date(),
      }
    );
  }

  /**
   * Mark key as failed
   * @param {string} key - Idempotency key
   * @param {string} userId - User ID
   */
  static async markFailed(key, userId) {
    if (!key) return;

    await IdempotencyKey.findOneAndUpdate({ key, userId }, { status: 'failed' });
  }
}

module.exports = IdempotencyService;
