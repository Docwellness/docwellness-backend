const User = require('../models/User');
const asyncHandler = require('../utils/async-handler');
const ApiError = require('../utils/api-error');
const { sendSuccess } = require('../utils/api-response');

/**
 * POST /api/patient/device-token
 * POST /api/dietician/device-token
 * Register/refresh this device's FCM token for push notifications.
 * Shared handler for both roles - mirrors notificationController.js's
 * role-agnostic, userId-keyed convention.
 */
exports.registerDeviceToken = asyncHandler(async (req, res) => {
  const { token, platform } = req.body || {};
  if (!token || !['android', 'ios'].includes(platform)) {
    throw ApiError.badRequest('token and platform ("android" | "ios") are required');
  }

  const user = await User.findById(req.user._id).select('deviceTokens');
  if (!user) throw ApiError.notFound('User not found');

  const existing = user.deviceTokens.find((t) => t.token === token);
  if (existing) {
    existing.platform = platform;
    existing.updatedAt = new Date();
  } else {
    user.deviceTokens.push({ token, platform, updatedAt: new Date() });
  }
  await user.save();

  return sendSuccess(res, { data: { ok: true } });
});
