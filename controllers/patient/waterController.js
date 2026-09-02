const WaterLog = require('../../models/WaterLog');
const { invalidatePatientStats } = require('../../utils/patientStatsCache');

/**
 * POST /api/patient/water/log
 * Log water intake (or sync from local storage)
 * Body: { date: "2026-02-27", entries: [{ amount: 250, time: "14:30" }], goal?: 2500 }
 */
exports.logWater = async (req, res) => {
  try {
    const patientId = req.user._id;
    const { date, entries, goal } = req.body;

    if (!date || !entries || !Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'date and entries[] are required',
      });
    }

    // Find or create the log for this date
    let waterLog = await WaterLog.findOne({ patientId, date });

    if (!waterLog) {
      waterLog = new WaterLog({
        patientId,
        date,
        goal: goal || 2500,
        entries: [],
        totalAmount: 0,
      });
    }

    // Only update goal if explicitly provided AND doc was just created
    // (don't overwrite a goal that was set via PUT /water/goal)
    // We already set goal above for new docs

    // Validate and add new entries
    const skipped = [];
    for (const entry of entries) {
      if (!entry.amount || !entry.time) {
        skipped.push(entry);
        continue;
      }
      // Dedupe on timestamp (millisecond precision), not time+amount - the
      // app always logs a fixed stepSize (e.g. every tap is the same
      // 0.25L/250ml), so two legitimate taps a few seconds apart share both
      // the same `amount` AND the same minute-granular `time` ("HH:mm").
      // Matching on that pair silently dropped every entry in a batch after
      // the first whenever a patient logged more than one glass within the
      // same minute (very much the normal case for the app's debounced
      // burst-of-taps sync) - the water total would stay stuck at whatever
      // the first tap's worth was, no matter how many more times "+" was
      // tapped. entry.timestamp is unique per tap (see
      // WaterController.addWater/addWaterToViewedDay), so it's what
      // actually identifies "this exact log", not amount/time.
      const entryTimestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : null;
      const exists =
        entryTimestamp != null &&
        waterLog.entries.some((e) => e.timestamp && new Date(e.timestamp).getTime() === entryTimestamp);
      if (!exists) {
        waterLog.entries.push({
          amount: entry.amount,
          time: entry.time,
          timestamp: entry.timestamp || new Date(),
        });
      }
    }

    // Recalculate total
    waterLog.totalAmount = waterLog.entries.reduce((sum, e) => sum + e.amount, 0);

    await waterLog.save();

    // Water Intake feeds the Goal Journey timeline's adherence/streak
    // (task 2.6/2.3) - drop this patient's cached stat windows.
    await invalidatePatientStats(patientId);

    return res.status(200).json({
      success: true,
      message:
        skipped.length > 0
          ? `Water intake logged (${skipped.length} invalid entries skipped)`
          : 'Water intake logged',
      data: waterLog,
      ...(skipped.length > 0 && { skippedEntries: skipped }),
    });
  } catch (error) {
    console.error('logWater error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error logging water intake',
    });
  }
};

/**
 * GET /api/patient/water/today
 * Get today's water log
 */
exports.getToday = async (req, res) => {
  try {
    const patientId = req.user._id;
    // Prefer client-sent date (local timezone) over server UTC date
    const today = req.query.date || new Date().toISOString().split('T')[0]; // "2026-02-27"

    const waterLog = await WaterLog.findOne({ patientId, date: today });

    return res.status(200).json({
      success: true,
      data: waterLog || { date: today, totalAmount: 0, goal: 2500, entries: [] },
    });
  } catch (error) {
    console.error('getToday water error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * GET /api/patient/water/history?days=7
 * Get water intake history for the last N days (for chart)
 */
exports.getHistory = async (req, res) => {
  try {
    const patientId = req.user._id;
    const days = parseInt(req.query.days) || 7;
    const actualDays = days < 1 ? 7 : days;

    // Build date range
    const dates = [];
    for (let i = actualDays - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().split('T')[0]);
    }

    const logs = await WaterLog.find({
      patientId,
      date: { $in: dates },
    }).sort({ date: 1 });

    // Fill in missing days with zero
    const history = dates.map((date) => {
      const log = logs.find((l) => l.date === date);
      return {
        date,
        totalAmount: log ? log.totalAmount : 0,
        goal: log ? log.goal : 2500,
        entries: log ? log.entries : [],
      };
    });

    return res.status(200).json({
      success: true,
      data: history,
    });
  } catch (error) {
    console.error('getHistory water error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * PUT /api/patient/water/goal
 * Update daily water goal
 * Body: { goal: 3000 }
 */
exports.updateGoal = async (req, res) => {
  try {
    const patientId = req.user._id;
    const { goal } = req.body;

    if (!goal || goal < 500 || goal > 10000) {
      return res.status(400).json({
        success: false,
        message: 'Goal must be between 500ml and 10000ml',
      });
    }

    // Update today's log goal (or create one)
    // Use client-sent date if available, fall back to server UTC
    const today = req.query.date || req.body.date || new Date().toISOString().split('T')[0];
    await WaterLog.findOneAndUpdate(
      { patientId, date: today },
      { $set: { goal } },
      { upsert: true, new: true }
    );

    await invalidatePatientStats(patientId);

    return res.status(200).json({
      success: true,
      message: 'Water goal updated',
      data: { goal },
    });
  } catch (error) {
    console.error('updateGoal water error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};
