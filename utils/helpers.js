const multer = require('multer');
const path = require('path');
const config = require('../config/environment');

// Configure multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, config.uploadPath);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  },
});

// File filter
const fileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|gif|webp/;
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  const mimetype = allowedTypes.test(file.mimetype);

  if (extname && mimetype) {
    cb(null, true);
  } else {
    cb(new Error('Only image files are allowed!'), false);
  }
};

// Multer upload configuration
const upload = multer({
  storage,
  limits: {
    fileSize: config.maxFileSize,
  },
  fileFilter,
});

// Calculate BMI
const calculateBMI = (weight, height) => {
  if (!weight || !height) return null;
  const heightInMeters = height / 100;
  return (weight / (heightInMeters * heightInMeters)).toFixed(2);
};

// Calculate daily calorie needs (Mifflin-St Jeor Equation)
const calculateCalorieNeeds = (weight, height, age, gender, activityLevel) => {
  let bmr;

  if (gender === 'Male') {
    bmr = 10 * weight + 6.25 * height - 5 * age + 5;
  } else {
    bmr = 10 * weight + 6.25 * height - 5 * age - 161;
  }

  const activityMultipliers = {
    Sedentary: 1.2,
    'Lightly Active': 1.375,
    'Moderately Active': 1.55,
    'Very Active': 1.725,
  };

  const multiplier = activityMultipliers[activityLevel] || 1.2;
  return Math.round(bmr * multiplier);
};

// Format date
const formatDate = (date) => {
  return new Date(date).toLocaleDateString('en-IN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
};

// Generate random string
const generateRandomString = (length = 32) => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

// Paginate results
const paginate = (page = 1, limit = 10) => {
  const skip = (parseInt(page) - 1) * parseInt(limit);
  return {
    skip,
    limit: parseInt(limit),
  };
};

// Create pagination response
const paginationResponse = (total, page, limit) => {
  return {
    total,
    page: parseInt(page),
    pages: Math.ceil(total / limit),
    hasMore: parseInt(page) < Math.ceil(total / limit),
  };
};

// Sanitize user object (remove sensitive fields)
const sanitizeUser = (user) => {
  const sanitized = user.toObject ? user.toObject() : { ...user };
  delete sanitized.password;
  delete sanitized.resetPasswordToken;
  delete sanitized.resetPasswordExpire;
  return sanitized;
};

// Sleep utility
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = {
  upload,
  calculateBMI,
  calculateCalorieNeeds,
  formatDate,
  generateRandomString,
  paginate,
  paginationResponse,
  sanitizeUser,
  sleep,
};
