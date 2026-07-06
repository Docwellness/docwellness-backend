/**
 * Counter Model for Atomic Sequence Allocation
 * Used for per-conversation monotonic server_seq
 */

const mongoose = require('mongoose');

const counterSchema = new mongoose.Schema(
  {
    // e.g., "conv:<conversationId>"
    _id: {
      type: String,
      required: true,
    },
    seq: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

/**
 * Atomically increment and return the next sequence number
 * @param {string} key - Counter key (e.g., "conv:abc123")
 * @returns {Promise<number>} Next sequence number
 */
counterSchema.statics.getNextSeq = async function (key) {
  const result = await this.findByIdAndUpdate(
    key,
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return result.seq;
};

/**
 * Get current sequence without incrementing
 * @param {string} key - Counter key
 * @returns {Promise<number>} Current sequence number
 */
counterSchema.statics.getCurrentSeq = async function (key) {
  const counter = await this.findById(key);
  return counter ? counter.seq : 0;
};

module.exports = mongoose.model('Counter', counterSchema);
