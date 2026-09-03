const { getUserFromSupabaseToken } = require('../utils/supabaseAuth');

const authMiddleware = async (req, res, next) => {
  try {
    let token;

    // Check for token in Authorization header
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Not authorized, no token provided',
      });
    }

    try {
      req.user = await getUserFromSupabaseToken(token);
      next();
    } catch (error) {
      if (error.code === 'no_profile') {
        return res.status(409).json({
          success: false,
          message: 'Account exists but registration was never completed',
          code: 'no_profile',
        });
      }
      if (error.code === 'account_disabled') {
        // 403, not 401: the token is valid, the account is not. `code` lets
        // the client show the right message / force a logout.
        return res.status(403).json({
          success: false,
          message: 'This account has been deactivated. Please contact your dietician.',
          code: 'account_disabled',
        });
      }
      return res.status(401).json({
        success: false,
        message: 'Not authorized, token invalid',
      });
    }
  } catch (error) {
    next(error);
  }
};

module.exports = authMiddleware;
