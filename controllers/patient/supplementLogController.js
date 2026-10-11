const SupplementLog = require('../../models/SupplementLog');
const { rejectIfPaused } = require('../../utils/patientPauseGuard');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function readKey(src) {
  const { date, supplementId, servingTime, timingAnchor } = src || {};
  if (!DATE_RE.test(String(date || '')) || !supplementId || !servingTime) return null;
  return {
    date: String(date),
    supplementId: String(supplementId),
    servingTime: String(servingTime),
    timingAnchor: ['pre', 'with', 'post'].includes(timingAnchor) ? timingAnchor : 'with',
  };
}

/** GET /api/patient/supplement-log?date=YYYY-MM-DD - what was ticked off that day. */
exports.getSupplementLogs = async (req, res) => {
  try {
    const date = String(req.query.date || '');
    if (!DATE_RE.test(date)) {
      return res.status(400).json({ success: false, message: 'date (YYYY-MM-DD) is required' });
    }
    const logs = await SupplementLog.find({ patientId: req.user._id, date })
      .select('supplementId servingTime timingAnchor loggedAt -_id')
      .lean();
    return res.status(200).json({ success: true, data: { date, logs } });
  } catch (error) {
    console.error('getSupplementLogs error:', error);
    return res.status(500).json({ success: false, message: 'Server error fetching supplement logs' });
  }
};

/** POST /api/patient/supplement-log - idempotent "mark as taken". */
exports.logSupplement = async (req, res) => {
  try {
    const key = readKey(req.body);
    if (!key) {
      return res
        .status(400)
        .json({ success: false, message: 'date, supplementId and servingTime are required' });
    }
    if (await rejectIfPaused(res, req.user._id, new Date(key.date))) return;

    await SupplementLog.updateOne(
      { patientId: req.user._id, ...key },
      { $setOnInsert: { loggedAt: new Date() } },
      { upsert: true }
    );
    return res.status(200).json({ success: true, message: 'Supplement logged' });
  } catch (error) {
    console.error('logSupplement error:', error);
    return res.status(500).json({ success: false, message: 'Server error logging supplement' });
  }
};

/** DELETE /api/patient/supplement-log - un-log (query params, same fields). */
exports.unlogSupplement = async (req, res) => {
  try {
    const key = readKey(req.query);
    if (!key) {
      return res
        .status(400)
        .json({ success: false, message: 'date, supplementId and servingTime are required' });
    }
    if (await rejectIfPaused(res, req.user._id, new Date(key.date))) return;

    await SupplementLog.deleteOne({ patientId: req.user._id, ...key });
    return res.status(200).json({ success: true, message: 'Supplement log removed' });
  } catch (error) {
    console.error('unlogSupplement error:', error);
    return res.status(500).json({ success: false, message: 'Server error removing supplement log' });
  }
};
