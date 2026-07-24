const authMiddleware = require('./auth');
const supabaseTokenOnly = require('./supabaseTokenOnly');
const { roleCheck, patientOnly, dieticianOnly, adminOnly } = require('./roleCheck');
const errorHandler = require('./error');
const requestLogger = require('./requestLogger');
const sanitizeInput = require('./sanitizeInput');
const { authLimiter, messageLimiter, aiGenerationLimiter, uploadLimiter } = require('./rateLimiters');
const {
  validate,
  schemas,
  validateRegister,
  validateUpdateProfile,
} = require('./validation');

module.exports = {
  authMiddleware,
  supabaseTokenOnly,
  roleCheck,
  patientOnly,
  dieticianOnly,
  adminOnly,
  errorHandler,
  requestLogger,
  sanitizeInput,
  authLimiter,
  messageLimiter,
  aiGenerationLimiter,
  uploadLimiter,
  validate,
  schemas,
  validateRegister,
  validateUpdateProfile,
};
