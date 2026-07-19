require('dotenv').config();

module.exports = {
  port: process.env.PORT || 5000,
  nodeEnv: process.env.NODE_ENV || 'development',
  mongodbUri: process.env.MONGODB_URI,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpire: process.env.JWT_EXPIRE || '7d',
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID,
    keySecret: process.env.RAZORPAY_KEY_SECRET,
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
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    // Pinned explicit snapshots (not bare aliases) so behavior can't silently
    // drift when OpenAI repoints an alias to a newer default model.
    recipeModel: process.env.OPENAI_MODEL_RECIPE || 'gpt-4o',
    translationModel: process.env.OPENAI_MODEL_TRANSLATION || 'gpt-4o-mini',
    dietPlanModel: process.env.OPENAI_MODEL_DIET_PLAN || 'gpt-4o',
  },
  uploadPath: process.env.UPLOAD_PATH || './uploads',
  maxFileSize: parseInt(process.env.MAX_FILE_SIZE) || 5242880, // 5MB
  defaultDieticianId: process.env.DEFAULT_DIETICIAN_ID,
  sentryDsn: process.env.SENTRY_DSN,
};
