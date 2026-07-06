const authMiddleware = require('./auth');
const { roleCheck, patientOnly, dieticianOnly, adminOnly } = require('./roleCheck');
const errorHandler = require('./errorHandler');
const {
  validate,
  schemas,
  validateRegister,
  validateLogin,
  validateUpdateProfile,
} = require('./validation');

module.exports = {
  authMiddleware,
  roleCheck,
  patientOnly,
  dieticianOnly,
  adminOnly,
  errorHandler,
  validate,
  schemas,
  validateRegister,
  validateLogin,
  validateUpdateProfile,
};
