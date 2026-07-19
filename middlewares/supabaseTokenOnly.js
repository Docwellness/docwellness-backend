const { verifySupabaseToken } = require('../utils/supabaseAuth');

// Verifies a Supabase access token WITHOUT requiring a linked Mongo User to
// already exist - unlike the main auth middleware. Only for the
// registration-completion endpoint, which is exactly what creates that link.
const supabaseTokenOnly = async (req, res, next) => {
  try {
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Not authorized, no token provided',
      });
    }

    req.supabaseUser = await verifySupabaseToken(token);
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Not authorized, token invalid',
    });
  }
};

module.exports = supabaseTokenOnly;
