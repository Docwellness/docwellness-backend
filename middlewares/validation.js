const Joi = require('joi');

// Validation schemas
const schemas = {
  // Unified Registration
  register: Joi.object({
    username: Joi.string().min(3).max(30).required().messages({
      'string.min': 'Username must be at least 3 characters',
      'string.max': 'Username cannot exceed 30 characters',
      'any.required': 'Username is required',
    }),
    email: Joi.string().email().required().messages({
      'string.email': 'Please enter a valid email',
      'any.required': 'Email is required',
    }),
    password: Joi.string().min(6).required().messages({
      'string.min': 'Password must be at least 6 characters',
      'any.required': 'Password is required',
    }),
    profile: Joi.object({
      fullName: Joi.string().trim().required().messages({
        'any.required': 'Full name is required',
      }),
      gender: Joi.string().valid('Male', 'Female', 'Other').required().messages({
        'any.only': 'Gender must be Male, Female, or Other',
        'any.required': 'Gender is required',
      }),
      dateOfBirth: Joi.string()
        .pattern(/^\d{2}-\d{2}-\d{4}$/)
        .required()
        .messages({
          'string.pattern.base': 'Date of birth must be in DD-MM-YYYY format',
          'any.required': 'Date of birth is required',
        }),
      whatsappNumber: Joi.string()
        .pattern(/^\+?[0-9]{10,15}$/)
        .required()
        .messages({
          'string.pattern.base': 'Please enter a valid phone number (10-15 digits, optional +)',
          'any.required': 'WhatsApp number is required',
        }),
    })
      .required()
      .messages({
        'any.required': 'Profile information is required',
      }),
    healthProfile: Joi.object({
      weight: Joi.number().positive().required().messages({
        'number.positive': 'Weight must be a positive number',
        'any.required': 'Weight is required',
      }),
      height: Joi.number().positive().required().messages({
        'number.positive': 'Height must be a positive number',
        'any.required': 'Height is required',
      }),
      bmi: Joi.number().positive().precision(1).required().messages({
        'number.positive': 'BMI must be a positive number',
        'any.required': 'BMI is required',
      }),
      weightIndex: Joi.number().integer().valid(0, 1, 2, 3).required().messages({
        'number.base': 'Weight index must be an integer',
        'any.only':
          'Weight index must be 0 (Normal), 1 (Underweight), 2 (Overweight), or 3 (Obese)',
        'any.required': 'Weight index is required',
      }),
      primaryGoal: Joi.string()
        .valid(
          'Weight Loss',
          'Weight Gain',
          'Maintain Weight',
          'Muscle Building',
          'Thyroid Control',
          'PCOD Control'
        )
        .required()
        .messages({
          'any.only': 'Invalid primary goal',
          'any.required': 'Primary goal is required',
        }),
      targetWeight: Joi.string().required().messages({
        'any.required': 'Target weight is required',
      }),
      activityLevel: Joi.string()
        .valid('Sedentary', 'Lightly Activity', 'Moderately Activity', 'Very Active')
        .required()
        .messages({
          'any.only': 'Invalid activity level',
          'any.required': 'Activity level is required',
        }),
      healthConcerns: Joi.array()
        .items(
          Joi.string().valid(
            "I don't have any of these",
            'Hypertension',
            'High Cholesterol',
            'Obesity',
            'Diabetes',
            'Heart Disease',
            'Cancer',
            'Thyroid',
            'Thyroid Disease',
            'PCOD/PCOS',
            'Gastric Disease',
            'Lung Disease',
            'Other'
          )
        )
        .min(1)
        .required()
        .messages({
          'array.min': 'Please select at least one health concern',
          'any.required': 'Health concerns are required',
        }),
    })
      .required()
      .messages({
        'any.required': 'Health profile is required',
      }),
  }),

  // Login with email or username
  login: Joi.object({
    email: Joi.string().email(),
    username: Joi.string().min(3),
    password: Joi.string().required(),
  })
    .xor('email', 'username')
    .messages({
      'object.xor': 'Either email or username is required for login',
    }),
  updateProfile: Joi.object({
    profile: Joi.object({
      fullName: Joi.string().trim(),
      whatsappNumber: Joi.string().pattern(/^[0-9]{10,15}$/),
      dateOfBirth: Joi.string()
        .pattern(/^\d{2}-\d{2}-\d{4}$/)
        .messages({
          'string.pattern.base': 'Date of birth must be in DD-MM-YYYY format',
        }),
      gender: Joi.string().valid('Male', 'Female', 'Other'),
    }),
    healthProfile: Joi.object({
      weight: Joi.number().positive(),
      height: Joi.number().positive(),
      bmi: Joi.number().positive().precision(1),
      weightIndex: Joi.number().integer().valid(0, 1, 2, 3),
      primaryGoal: Joi.string().valid(
        'Weight Loss',
        'Weight Gain',
        'Maintain Weight',
        'Muscle Building',
        'Thyroid Control',
        'PCOD Control'
      ),
      targetWeight: Joi.string(),
      activityLevel: Joi.string().valid(
        'Sedentary',
        'Lightly Active',
        'Moderately Active',
        'Very Active'
      ),
      healthConcerns: Joi.array().items(Joi.string()),
    }),
  }),

  createMealLog: Joi.object({
    date: Joi.date(),
    meals: Joi.array().items(
      Joi.object({
        mealType: Joi.string().valid('Breakfast', 'Lunch', 'Dinner', 'Snack').required(),
        recipeId: Joi.string(),
        servings: Joi.number().positive(),
        caloriesConsumed: Joi.number(),
        notes: Joi.string(),
      })
    ),
  }),

  createProgress: Joi.object({
    date: Joi.date(),
    weight: Joi.number().positive(),
    notes: Joi.string(),
  }),

  manualPaymentProof: Joi.object({
    requestId: Joi.string().length(24).hex().required().messages({
      'string.length': 'requestId must be a valid 24 character id',
      'string.hex': 'requestId must be a valid hexadecimal id',
      'any.required': 'requestId is required',
    }),
    amountReceived: Joi.number().min(0).required().messages({
      'number.min': 'Amount received cannot be negative',
      'any.required': 'Amount received is required',
    }),
    amountPending: Joi.number().min(0).required().messages({
      'number.min': 'Amount pending cannot be negative',
      'any.required': 'Amount pending is required',
    }),
    description: Joi.string().max(500).allow('', null).messages({
      'string.max': 'Description cannot exceed 500 characters',
    }),
  }).unknown(true),
};

// Validation middleware
const validate = (schemaName) => {
  return (req, res, next) => {
    const schema = schemas[schemaName];
    if (!schema) {
      return next(new Error(`Schema '${schemaName}' not found`));
    }

    const { error } = schema.validate(req.body, { abortEarly: false });

    if (error) {
      const errors = error.details.map((detail) => detail.message);
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors,
      });
    }

    next();
  };
};

// Export individual validators for routes
const validateRegister = validate('register');
const validateLogin = validate('login');
const validateUpdateProfile = validate('updateProfile');
const validateManualPaymentProof = validate('manualPaymentProof');

module.exports = {
  validate,
  schemas,
  validateRegister,
  validateLogin,
  validateUpdateProfile,
  validateManualPaymentProof,
};
