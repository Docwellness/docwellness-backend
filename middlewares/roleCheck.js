/**
 * Role Check Middleware
 * Restricts access to routes based on user roles
 */

const roleCheck = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Not authorized - no user found',
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Access denied. Role '${req.user.role}' is not authorized to access this resource`,
      });
    }

    next();
  };
};

/**
 * Patient Only Middleware
 * Shorthand for roleCheck('patient')
 */
const patientOnly = roleCheck('patient');

/**
 * Dietician Only Middleware
 * Shorthand for roleCheck('dietician')
 */
const dieticianOnly = roleCheck('dietician');

/**
 * Admin Only Middleware
 * Shorthand for roleCheck('admin')
 */
const adminOnly = roleCheck('admin');

module.exports = {
  roleCheck,
  patientOnly,
  dieticianOnly,
  adminOnly,
};
