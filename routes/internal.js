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

module.exports = router;
