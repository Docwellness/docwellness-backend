const authMiddleware = require('./auth');
const supabaseTokenOnly = require('./supabaseTokenOnly');
const { roleCheck, patientOnly, dieticianOnly, adminOnly } = require('./roleCheck');
const errorHandler = require('./errorHandler');
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
  validate,
  schemas,
  validateRegister,
  validateUpdateProfile,
};
