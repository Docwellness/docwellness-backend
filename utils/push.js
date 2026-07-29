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
    app = admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
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
  if (!fcmApp || !Array.isArray(tokens) || tokens.length === 0) return;

  try {
    // eslint-disable-next-line global-require
    const admin = require('firebase-admin');
    const stringData = {};
    for (const [key, value] of Object.entries(data || {})) {
      stringData[key] = String(value);
    }

    const response = await admin.messaging(fcmApp).sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: stringData,
    });

    response.responses.forEach((r, i) => {
      if (!r.success && r.error?.code === 'messaging/registration-token-not-registered') {
        onInvalidToken?.(tokens[i]);
      }
    });
  } catch (err) {
    console.error('[push] send failed (non-fatal):', err.message);
  }
}

module.exports = { sendPushToTokens, isEnabled: () => Boolean(getApp()) };
