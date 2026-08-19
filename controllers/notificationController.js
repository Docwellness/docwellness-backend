const Notification = require('../models/Notification');
const { getOrSetJSON } = require('../utils/cache');

// AI_EXECUTION_PLAN.md Phase 5, P5-06 - same short-TTL, no-invalidation
// tradeoff as chat/controllers/index.js's getUnreadCount: this badge count
// is read far more often than it changes, and a few seconds of staleness
// is an acceptable cost for not building write-path invalidation.
const UNREAD_COUNT_CACHE_TTL_SECONDS = 20;

/**
 * GET /api/dietician/notifications
 * List notifications for the logged-in user (newest first).
 * Query: ?page=1&limit=20
 */
exports.getNotifications = async (req, res) => {
  try {
    const userId = req.user._id;
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 50);
    const skip = (page - 1) * limit;

    const [notifications, total, unreadCount] = await Promise.all([
      Notification.find({ userId }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Notification.countDocuments({ userId }),
      Notification.countDocuments({ userId, isRead: false }),
    ]);

    return res.json({
      success: true,
      data: {
        notifications,
        unreadCount,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      },
    });
  } catch (err) {
    console.error('getNotifications error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * GET /api/dietician/notifications/unread-count
 * Quick count of unread notifications (for badge).
 */
exports.getUnreadCount = async (req, res) => {
  try {
    const userId = req.user._id;
    const count = await getOrSetJSON(
      `notifications:unread-count:${userId}`,
      UNREAD_COUNT_CACHE_TTL_SECONDS,
      () => Notification.countDocuments({ userId, isRead: false })
    );
    return res.json({ success: true, data: { unreadCount: count } });
  } catch (err) {
    console.error('getUnreadCount error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * PUT /api/dietician/notifications/:id/read
 * Mark a single notification as read.
 */
exports.markAsRead = async (req, res) => {
  try {
    const notif = await Notification.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { isRead: true },
      { new: true }
    );
    if (!notif) {
      return res.status(404).json({ success: false, message: 'Notification not found' });
    }
    return res.json({ success: true, data: notif });
  } catch (err) {
    console.error('markAsRead error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * PUT /api/dietician/notifications/read-all
 * Mark all notifications as read for the current user.
 */
exports.markAllAsRead = async (req, res) => {
  try {
    await Notification.updateMany({ userId: req.user._id, isRead: false }, { isRead: true });
    return res.json({ success: true, message: 'All notifications marked as read' });
  } catch (err) {
    console.error('markAllAsRead error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};
