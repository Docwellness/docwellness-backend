/**
 * Internal Routes
 * Cron-triggered routes, not reachable by normal patient/dietician auth.
 * Guarded by a shared secret (CRON_SECRET) instead of a user JWT, since the
 * caller is Vercel Cron (dev) or a VPS crontab entry (prod), not a logged-in
 * user - see docs/cron-setup.md.
 */

const express = require('express');
const router = express.Router();

const config = require('../config/environment');
const { runRenewalReminderSweep } = require('../controllers/internal/renewalReminderController');
const { runGoalNudgeSweep } = require('../controllers/internal/goalNudgeController');
const { runMealReminderSweep } = require('../controllers/internal/mealReminderController');
const { runWaterReminderSweep } = require('../controllers/internal/waterReminderController');
const { drainJobs, stats: jobQueueStats } = require('../utils/jobQueue');

function requireCronSecret(req, res, next) {
  // Two trigger sources need to authenticate here: Vercel Cron (dev), which
  // automatically sends `Authorization: Bearer <CRON_SECRET>` when a
  // CRON_SECRET env var is set on the project (Vercel's own convention -
  // there's no way to make it send a custom header instead), and a VPS
  // crontab entry (prod, the one that actually reaches real patients - see
  // docs/cron-setup.md), which uses a plain custom header via curl. Accept
  // either so both work without duplicating the secret under two names.
  const bearerMatch = /^Bearer (.+)$/.exec(req.headers['authorization'] || '');
  const provided = req.headers['x-cron-secret'] || (bearerMatch ? bearerMatch[1] : null);
  if (!config.cronSecret || provided !== config.cronSecret) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  next();
}

/**
 * @route   POST /api/internal/cron/renewal-reminders
 * @desc    Daily sweep: notify patients whose membership expires within 3
 *          days and haven't already been reminded for this expiry.
 */
router.post('/cron/renewal-reminders', requireCronSecret, async (req, res, next) => {
  try {
    const result = await runRenewalReminderSweep();
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/internal/cron/goal-nudges
 * @desc    Daily sweep: nudge patients whose goal endDate passed without
 *          reaching their target to continue their diet journey and rebook.
 */
router.post('/cron/goal-nudges', requireCronSecret, async (req, res, next) => {
  try {
    const result = await runGoalNudgeSweep();
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/internal/cron/meal-reminder?slot=Breakfast
 * @desc    Fixed-time sweep (see vercel.json - one cron entry per
 *          servingTime slot): reminds patients who have that slot planned
 *          for today's day-group and haven't logged it yet.
 */
router.post('/cron/meal-reminder', requireCronSecret, async (req, res, next) => {
  try {
    const result = await runMealReminderSweep({ slot: req.query.slot });
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/internal/cron/water-reminder?checkpoint=1
 * @desc    Fixed-time sweep (see vercel.json - 4 checkpoints across the
 *          day): reminds patients who haven't reached their water goal yet.
 */
router.post('/cron/water-reminder', requireCronSecret, async (req, res, next) => {
  try {
    const result = await runWaterReminderSweep({ checkpoint: req.query.checkpoint });
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET|POST /api/internal/cron/drain-jobs?max=25
 * @desc    Cross-app performance optimization, Phase 3 (task 3.1): drain a
 *          bounded batch off the async job queue (utils/jobQueue.js) -
 *          currently outbound emails moved off the request path. Idempotent
 *          and safe to run on a tight schedule (every minute); a no-op when
 *          REDIS_URL isn't configured. GET and POST both work so it can be
 *          driven by a Vercel Cron entry (GET) or a VPS curl (POST).
 */
async function drainJobsHandler(req, res, next) {
  try {
    const parsed = parseInt(req.query.max, 10);
    const max = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 100) : undefined;
    const result = await drainJobs(max ? { max } : {});
    res.status(200).json({ success: true, data: { ...result, queue: await jobQueueStats() } });
  } catch (error) {
    next(error);
  }
}
router.get('/cron/drain-jobs', requireCronSecret, drainJobsHandler);
router.post('/cron/drain-jobs', requireCronSecret, drainJobsHandler);

module.exports = router;
