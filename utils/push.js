/**
 * Optional FCM push client - same "optional integration degrades
 * gracefully" convention as utils/redisClient.js: when
 * FCM_SERVICE_ACCOUNT_BASE64 isn't configured, every export here is a
 * no-op instead of throwing, so nothing in this codebase ever hard-requires
 * a configured Firebase project to boot or serve a request.
 */

const config = require('../config/environment');

let app = null;

function getApp() {
  if (app) return app;
  if (!config.fcm.serviceAccountBase64) return null;

  try {
    // eslint-disable-next-line global-require
    const admin = require('firebase-admin');
    const serviceAccountJson = Buffer.from(config.fcm.serviceAccountBase64, 'base64').toString('utf8');
    const serviceAccount = JSON.parse(serviceAccountJson);
    // firebase-admin v14 removed the old admin.credential.* namespace -
    // cert() is exported directly at the top level now. admin.credential
    // was undefined (not the serviceAccount JSON) that was actually
    // throwing here ("Cannot read properties of undefined (reading
    // 'cert')"), silently disabling every push send in any environment
    // where FCM_SERVICE_ACCOUNT_BASE64 was actually configured - this
    // never surfaced locally/on Vercel dev because that env var is unset
    // there, so getApp() returned null before ever reaching this line.
    app = admin.initializeApp({ credential: admin.cert(serviceAccount) });
    console.log(`[push] firebase-admin initialized (project: ${serviceAccount.project_id || 'unknown'})`);
    return app;
  } catch (err) {
    console.error('[push] failed to initialize firebase-admin, push disabled:', err.message);
    return null;
  }
}

/**
 * Sends a push to every token in `tokens` (from User.deviceTokens). Prunes
 * dead tokens via `onInvalidToken(token)` so callers can remove them from
 * the user document - never throws, a push failure must never fail the
 * caller's own request.
 */
async function sendPushToTokens(tokens, { title, body, data } = {}, onInvalidToken) {
  const fcmApp = getApp();
  // Both silent-return conditions had no logging at all, on either side of
  // the two firebase-admin API fixes above - impossible to tell from
  // Coolify logs alone whether a "nothing happened" push was this early
  // return (no fcmApp, or this user has zero registered device tokens) or
  // a genuine send that actually reached FCM. Logged now specifically so
  // that distinction is visible without guessing.
  if (!fcmApp) {
    console.warn('[push] skipped: getApp() returned null (FCM not configured or failed to init)');
    return;
  }
  if (!Array.isArray(tokens) || tokens.length === 0) {
    console.warn('[push] skipped: no device tokens for this user');
    return;
  }

  try {
    // eslint-disable-next-line global-require
    // Same firebase-admin v14 namespace removal as getApp() above -
    // admin.messaging(app) doesn't exist either (admin.messaging is
    // undefined at the top-level require) - getMessaging(app) via the
    // modular firebase-admin/messaging subpath is the replacement. This is
    // the second half of why push stayed broken after fixing getApp()
    // alone: initialization started succeeding, but every actual send then
    // threw "admin.messaging is not a function", caught right below and
    // logged as "[push] send failed" - same silent-failure shape as the
    // init bug, just one call further in.
    const { getMessaging } = require('firebase-admin/messaging');
    const stringData = {};
    for (const [key, value] of Object.entries(data || {})) {
      stringData[key] = String(value);
    }

    const response = await getMessaging(fcmApp).sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: stringData,
    });

    console.log(
      `[push] sent to ${tokens.length} token(s): ${response.successCount} succeeded, ${response.failureCount} failed`
    );
    response.responses.forEach((r, i) => {
      if (!r.success) {
        console.warn(`[push] token ${i} failed: ${r.error?.code || r.error?.message || 'unknown error'}`);
      }
      if (!r.success && r.error?.code === 'messaging/registration-token-not-registered') {
        onInvalidToken?.(tokens[i]);
      }
    });
  } catch (err) {
    console.error('[push] send failed (non-fatal):', err.message);
  }
}

module.exports = { sendPushToTokens, isEnabled: () => Boolean(getApp()) };
