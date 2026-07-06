const Coupon = require('../../models/Coupon');

/**
 * Parse a date string that may be DD/MM/YYYY or YYYY-MM-DD.
 */
function parseDate(str) {
  if (!str) return null;
  // DD/MM/YYYY
  const ddmm = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (ddmm) {
    return new Date(`${ddmm[3]}-${ddmm[2].padStart(2, '0')}-${ddmm[1].padStart(2, '0')}`);
  }
  // fallback — let JS try to parse it (works for YYYY-MM-DD, ISO, etc.)
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * @desc    Get all coupons for the dietician
 * @route   GET /api/dietician/coupons
 * @access  Dietician only
 */
exports.getCoupons = async (req, res) => {
  try {
    const coupons = await Coupon.find({ dieticianId: req.user._id })
      .sort({ createdAt: -1 })
      .lean();
    return res.status(200).json({ success: true, data: coupons });
  } catch (error) {
    console.error('getCoupons error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * @desc    Add a new coupon
 * @route   POST /api/dietician/coupons
 * @access  Dietician only
 */
exports.addCoupon = async (req, res) => {
  try {
    const { name, code, discountPercentage, validTill, isActive } = req.body;

    if (!name || !code || !discountPercentage || !validTill) {
      return res.status(400).json({
        success: false,
        message: 'name, code, discountPercentage, and validTill are required',
      });
    }

    const parsedDiscount = Number(discountPercentage);
    if (Number.isNaN(parsedDiscount) || parsedDiscount < 1 || parsedDiscount > 100) {
      return res.status(400).json({
        success: false,
        message: 'discountPercentage must be between 1 and 100',
      });
    }

    const coupon = await Coupon.create({
      dieticianId: req.user._id,
      name: name.trim(),
      code: code.trim().toUpperCase(),
      discountPercentage: parsedDiscount,
      validTill: parseDate(validTill),
      isActive: isActive === true || isActive === 'true',
    });

    return res.status(201).json({
      success: true,
      message: 'Coupon created successfully',
      data: coupon,
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'A coupon with this code already exists',
      });
    }
    console.error('addCoupon error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * @desc    Update an existing coupon
 * @route   PUT /api/dietician/coupons/:couponId
 * @access  Dietician only
 */
exports.updateCoupon = async (req, res) => {
  try {
    const { couponId } = req.params;
    const dieticianId = req.user._id;
    const { name, code, discountPercentage, validTill, isActive } = req.body;

    const coupon = await Coupon.findOne({ _id: couponId, dieticianId });
    if (!coupon) {
      return res.status(404).json({ success: false, message: 'Coupon not found' });
    }

    if (name !== undefined) coupon.name = name.trim();
    if (code !== undefined) coupon.code = code.trim().toUpperCase();
    if (discountPercentage !== undefined) {
      const parsed = Number(discountPercentage);
      if (Number.isNaN(parsed) || parsed < 1 || parsed > 100) {
        return res.status(400).json({
          success: false,
          message: 'discountPercentage must be between 1 and 100',
        });
      }
      coupon.discountPercentage = parsed;
    }
    if (validTill !== undefined) coupon.validTill = parseDate(validTill);
    if (isActive !== undefined) {
      coupon.isActive = isActive === true || isActive === 'true';
    }

    await coupon.save();

    return res.status(200).json({
      success: true,
      message: 'Coupon updated successfully',
      data: coupon,
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'A coupon with this code already exists',
      });
    }
    console.error('updateCoupon error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * @desc    Delete a coupon
 * @route   DELETE /api/dietician/coupons/:couponId
 * @access  Dietician only
 */
exports.deleteCoupon = async (req, res) => {
  try {
    const { couponId } = req.params;
    const dieticianId = req.user._id;

    const coupon = await Coupon.findOneAndDelete({ _id: couponId, dieticianId });
    if (!coupon) {
      return res.status(404).json({ success: false, message: 'Coupon not found' });
    }

    return res.status(200).json({
      success: true,
      message: 'Coupon deleted successfully',
    });
  } catch (error) {
    console.error('deleteCoupon error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};
