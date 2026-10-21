# Renewal reminder cron

`POST /api/internal/cron/renewal-reminders` runs a daily sweep (`controllers/internal/renewalReminderController.js::runRenewalReminderSweep`) that notifies any patient whose membership expires within the next 3 days. It's guarded by a shared secret (`CRON_SECRET` env var) instead of normal user auth, since it isn't called by a logged-in user.

A second sweep, `POST /api/internal/cron/goal-nudges` (`controllers/internal/goalNudgeController.js::runGoalNudgeSweep`), follows the exact same guard/trigger setup below - it notifies (in-app + best-effort push) any patient whose Goal Journey Timeline goal's `endDate` passed without reaching `targetValue`, nudging them to continue their diet journey and rebook their subscription. It's idempotent via `Goal.nudgeSentAt` (stamped once, never reset) rather than `DietPlanRequest.renewalReminderSentAt`'s per-cycle reset, since a goal doesn't get a fresh window on renewal.

Two more fixed-time sweeps follow the same guard/trigger setup:

- `POST /api/internal/cron/meal-reminder?slot=<servingTime>` (`controllers/internal/mealReminderController.js::runMealReminderSweep`) - one entry per servingTime slot (`Morning Drink`, `Breakfast`, `Brunch`, `Lunch`, `Evening Snack`, `Dinner`, `Night Drink`), each scheduled ~30min ahead of that slot's typical eating time. Reminds a patient only if today's day-group actually has that slot planned and they haven't logged it yet. Idempotent per day+slot via a `Notification` lookup (title+day window), since `referenceId` can't hold a composite key.
- `POST /api/internal/cron/water-reminder?checkpoint=<1-4>` (`controllers/internal/waterReminderController.js::runWaterReminderSweep`) - 4 fixed checkpoints spread across the day. Reminds a patient only if today's `WaterLog` total is still below goal at that checkpoint. Idempotent per checkpoint via a 1-hour `Notification` lookup window.

## Why there are two trigger paths

Production (`main` branch) runs on an Oracle Cloud VPS via Coolify (Docker-based). `dev` runs on Vercel only (serverless) — there's no VPS/persistent-process mirror for dev, so Socket.IO realtime features simply can't be tested against a live `dev` deployment; that's accepted as a known gap rather than worked around with extra infrastructure. A Vercel Cron job can only ever trigger the `dev` deployment; it never runs against real patients.

So both paths are wired up:

1. **Vercel Cron** (`vercel.json`'s `crons` entry, `0 3 * * *`) — fires against the `dev` Vercel deployment only. Useful for testing the route resolves correctly through Vercel's routing layer, but does not reach production.
2. **Oracle host crontab entry** (added manually — see below) — the only path that reaches real patients, since it hits the production API through its public domain. Unlike the old PM2 setup, this cron entry lives on the **host**, not inside the Coolify-managed container (the container's `localhost` isn't reachable from the host's crontab), so it targets the public HTTPS domain instead of `localhost:5000`.

## Manual setup

1. Set `CRON_SECRET=<a-random-secret>` as an environment variable on the production Coolify resource (Coolify UI → the app → Environment Variables).
2. Add a crontab entry on the Oracle VPS host (not inside the container):
   ```
   0 3 * * * curl -fsS -X POST -H "x-cron-secret: <same-secret>" https://api.docwellness.fit/api/internal/cron/renewal-reminders >> /var/log/docwellness-renewal-reminders.log 2>&1
   30 3 * * * curl -fsS -X POST -H "x-cron-secret: <same-secret>" https://api.docwellness.fit/api/internal/cron/goal-nudges >> /var/log/docwellness-goal-nudges.log 2>&1

   # Meal reminders - one per servingTime slot, ~30min ahead of typical eating time
   0 1 * * *  curl -fsS -X POST -H "x-cron-secret: <same-secret>" "https://api.docwellness.fit/api/internal/cron/meal-reminder?slot=Morning%20Drink" >> /var/log/docwellness-meal-reminders.log 2>&1
   0 3 * * *  curl -fsS -X POST -H "x-cron-secret: <same-secret>" "https://api.docwellness.fit/api/internal/cron/meal-reminder?slot=Breakfast" >> /var/log/docwellness-meal-reminders.log 2>&1
   0 5 * * *  curl -fsS -X POST -H "x-cron-secret: <same-secret>" "https://api.docwellness.fit/api/internal/cron/meal-reminder?slot=Brunch" >> /var/log/docwellness-meal-reminders.log 2>&1
   0 7 * * *  curl -fsS -X POST -H "x-cron-secret: <same-secret>" "https://api.docwellness.fit/api/internal/cron/meal-reminder?slot=Lunch" >> /var/log/docwellness-meal-reminders.log 2>&1
   0 11 * * * curl -fsS -X POST -H "x-cron-secret: <same-secret>" "https://api.docwellness.fit/api/internal/cron/meal-reminder?slot=Evening%20Snack" >> /var/log/docwellness-meal-reminders.log 2>&1
   0 14 * * * curl -fsS -X POST -H "x-cron-secret: <same-secret>" "https://api.docwellness.fit/api/internal/cron/meal-reminder?slot=Dinner" >> /var/log/docwellness-meal-reminders.log 2>&1
   30 15 * * * curl -fsS -X POST -H "x-cron-secret: <same-secret>" "https://api.docwellness.fit/api/internal/cron/meal-reminder?slot=Night%20Drink" >> /var/log/docwellness-meal-reminders.log 2>&1

   # Water reminders - 4 fixed checkpoints across the day
   30 4 * * *  curl -fsS -X POST -H "x-cron-secret: <same-secret>" "https://api.docwellness.fit/api/internal/cron/water-reminder?checkpoint=1" >> /var/log/docwellness-water-reminders.log 2>&1
   30 7 * * *  curl -fsS -X POST -H "x-cron-secret: <same-secret>" "https://api.docwellness.fit/api/internal/cron/water-reminder?checkpoint=2" >> /var/log/docwellness-water-reminders.log 2>&1
   30 10 * * * curl -fsS -X POST -H "x-cron-secret: <same-secret>" "https://api.docwellness.fit/api/internal/cron/water-reminder?checkpoint=3" >> /var/log/docwellness-water-reminders.log 2>&1
   30 13 * * * curl -fsS -X POST -H "x-cron-secret: <same-secret>" "https://api.docwellness.fit/api/internal/cron/water-reminder?checkpoint=4" >> /var/log/docwellness-water-reminders.log 2>&1
   ```
   All times are UTC (= IST minus 5:30) - the schedule above lands roughly at 6:30am/8:30am/10:30am/12:30pm/4:30pm/7:30pm/9:00pm IST for meals, and 10am/1pm/4pm/7pm IST for water. Replace `api.docwellness.fit` with the actual production domain configured on the Coolify resource.
3. Only if Redis is added to `dev` and the drain is triggered from outside Vercel (an external scheduler, or Vercel Pro): add the same `CRON_SECRET` value as a Vercel project env var (on the `dev` deployment). Vercel Cron then automatically sends `Authorization: Bearer <CRON_SECRET>`, which the route also accepts (see `routes/internal.js::requireCronSecret`). `dev` currently has neither `REDIS_URL` nor `CRON_SECRET`, so skip this step there.

## Notes

- `dev` on Vercel has no Redis, so background jobs run inline and `/api/internal/cron/drain-jobs` is deliberately not in `vercel.json` (production is expected to drain the queue via a host-side scheduled task every minute; confirm this in Coolify before merging to `main`). Vercel Hobby only accepts crons that run at most once a day (numeric minute and hour), so an every-minute entry makes the whole deploy fail. If Redis is ever added to `dev`, trigger the drain from an external scheduler or move to Vercel Pro. `tests/vercelCrons.test.js` guards this.
- The sweep is idempotent per expiry: `DietPlanRequest.renewalReminderSentAt` is stamped after notifying and reset to `null` on activation (`activateDietPlan`), so a patient is reminded once per subscription cycle, not once per cron run.
- The sweep is DB-only — no Socket.IO emission — since it must stay safe to run from a process with no socket server (Vercel). Real-time delivery, where it happens, comes from whichever client is already connected and polls/reconnects `GET /notifications`. A future enhancement could have the VPS-triggered run also call `getChatIO()` to emit `notification.new` immediately, since that path *does* have a live socket server — not implemented yet.
