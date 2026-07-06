const Coupon = require('../../models/Coupon');

/**
 * @desc    Validate a coupon code
 * @route   POST /api/patient/coupons/validate
 * @access  Private (Patient)
 */
exports.validateCoupon = async (req, res) => {
  try {
    const { code } = req.body;

    if (!code || !code.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Coupon code is required',
      });
    }

    const coupon = await Coupon.findOne({
      code: code.trim().toUpperCase(),
      isActive: true,
      validTill: { $gte: new Date() },
    }).lean();

    if (!coupon) {
      return res.status(404).json({
        success: false,
        message: 'Invalid or expired coupon code',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Coupon applied successfully',
      data: {
        name: coupon.name,
        code: coupon.code,
        discountPercentage: coupon.discountPercentage,
      },
    });
  } catch (error) {
    console.error('validateCoupon error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};
