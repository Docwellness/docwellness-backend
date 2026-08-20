require('dotenv').config();

// Fail fast rather than let the app boot into a broken state (e.g. every
// DB query throwing because MONGODB_URI is undefined, or every login
// silently failing because JWT_SECRET is undefined and jwt.sign() throws).
// Limited to the variables genuinely required for ANY request to work at
// all (DB access, JWT signing, Supabase-backed auth verification) - not
// every optional integration (Cloudinary/Resend/OpenAI/Pexels/
// Sentry all degrade that specific feature gracefully or are read with a
// safe default above, so they're deliberately excluded here rather than
// blocking startup over a feature nobody's using yet in this environment).
// Skipped entirely under NODE_ENV=test so the existing test suite (which
// never loads this module today, but might in the future) isn't forced to
// stand up a full production-shaped environment just to run.
const REQUIRED_ENV_VARS = ['MONGODB_URI', 'JWT_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];

if (process.env.NODE_ENV !== 'test') {
  const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `Missing required environment variable(s): ${missing.join(', ')}. See .env.example for the full list.`
    );
    process.exit(1);
  }
}

module.exports = {
  port: process.env.PORT || 5000,
  nodeEnv: process.env.NODE_ENV || 'development',
  // Allowed browser origins for CORS (see config/createApp.js) - only
  // matters for a browser-based consumer (e.g. a Flutter web build); native
  // mobile apps don't send an Origin header and are unaffected either way.
  // Unset by default - createApp.js stays permissive until these are
  // actually configured, so setting them is what locks CORS down, not a
  // prerequisite for the app to keep working today.
  clientOrigin: process.env.CLIENT_ORIGIN,
  dieticianOrigin: process.env.DIETICIAN_ORIGIN,
  // Whether app.js also initializes the legacy socket handler
  // (sockets/chatSocket.js) alongside the v1 one (chat/socket/index.js -
  // see AI_EXECUTION_PLAN.md Phase 4, P4-08). Defaults to true (both
  // active, today's actual behavior) so this is opt-OUT, not opt-in - flip
  // to 'false' only once every client is confirmed migrated to the v1
  // socket events (msg.*, conv.*, chat.*, presence.*).
  legacySocketCompat: process.env.LEGACY_SOCKET_COMPAT !== 'false',
  mongodbUri: process.env.MONGODB_URI,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpire: process.env.JWT_EXPIRE || '7d',
  supabase: {
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  },
  email: {
    resendApiKey: process.env.RESEND_API_KEY,
    // Resend's shared sandbox sender until docwellness.fit is verified in
    // Resend (SPF/DKIM/DMARC records) - sandbox can only deliver to the
    // Resend account's own verified email, not real users. Override with
    // RESEND_FROM_EMAIL once the domain is verified.
    fromAddress: process.env.RESEND_FROM_EMAIL || 'DocWellness <onboarding@resend.dev>',
    // Used for onboarding-style emails (e.g. the welcome email) that should
    // come from a real person rather than a no-reply address.
    fromAddressPersonal: process.env.RESEND_FROM_EMAIL_PERSONAL || process.env.RESEND_FROM_EMAIL || 'DocWellness <onboarding@resend.dev>',
  },
  // Used for links inside emails (e.g. "Go to Dashboard") - the marketing/
  // web app's own origin, not this API's.
  frontendUrl: process.env.FRONTEND_URL || 'https://docwellness.fit',
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    // Pinned explicit snapshots (not bare aliases) so behavior can't silently
    // drift when OpenAI repoints an alias to a newer default model.
    recipeModel: process.env.OPENAI_MODEL_RECIPE || 'gpt-4o',
    translationModel: process.env.OPENAI_MODEL_TRANSLATION || 'gpt-4o-mini',
    dietPlanModel: process.env.OPENAI_MODEL_DIET_PLAN || 'gpt-4o',
  },
  // Which engine services/dietPlanGenerationService.js uses to build new
  // diet-plan weeks: 'ai' (default, current OpenAI pipeline) or
  // 'deterministic' (the rules-based engine). Flipping this is the entire
  // cutover/rollback mechanism between the two - see that service's header.
  dietPlanEngine: (process.env.DIET_PLAN_ENGINE || 'ai').toLowerCase(),
  // v4.0: which storage model a NEWLY-CREATED DietPlan gets -
  // 'days-array' (default, current embedded days[]/servingMultiplier
  // system, live in production) or 'plan-item' (the new ingredient-level-
  // portioning/RecipeVersion system). Recorded once per-plan onto
  // DietPlan.dataModel at creation time (createAndGenerateDietPlan) and
  // never changes mid-life - flipping this env var only affects plans
  // created AFTER the flip; every existing Active/Finalized plan keeps
  // working exactly as before, untouched, forever. Do not set this to
  // 'plan-item' outside dev/staging until the Phase 7 regression suite is
  // green and Phase 0's per-dietician nutrition-data coverage gate is met -
  // see the "Diet Plan v4.0" plan doc's Phase 2 rollout sequencing.
  dietPlanDataModel: (process.env.DIET_PLAN_DATA_MODEL || 'days-array').toLowerCase(),
  uploadPath: process.env.UPLOAD_PATH || './uploads',
  maxFileSize: parseInt(process.env.MAX_FILE_SIZE) || 5242880, // 5MB
  defaultDieticianId: process.env.DEFAULT_DIETICIAN_ID,
  sentryDsn: process.env.SENTRY_DSN,
  // Shared secret for /api/internal/* cron-triggered routes (Vercel Cron on
  // dev, a VPS crontab entry on prod - see routes/internal.js) instead of
  // normal user JWT auth, since these aren't called by an authenticated user.
  cronSecret: process.env.CRON_SECRET,
  // Optional, per AI_EXECUTION_PLAN.md Phase 5 (P5-06/P5-07/P5-09) - unset
  // by default so dev/this-sandbox keeps working with zero Redis dependency.
  // See utils/redisClient.js: every caller goes through a wrapper that
  // no-ops (cache miss, no adapter) when this is null, rather than each
  // call site having to check config.redisUrl itself.
  redisUrl: process.env.REDIS_URL || null,
  // Optional FCM push (Goal Journey Timeline nudges). Unset by default -
  // utils/push.js no-ops entirely when this is null, same "optional
  // integration degrades gracefully" convention as redisUrl above. Value is
  // the full Firebase service-account JSON, base64-encoded - never a
  // committed file.
  fcm: {
    serviceAccountBase64: process.env.FCM_SERVICE_ACCOUNT_BASE64 || null,
  },
};
