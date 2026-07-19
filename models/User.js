const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    // Links this profile to its Supabase Auth identity - Supabase owns
    // credentials (password, sessions, password reset) entirely; this Mongo
    // document only holds profile/health/app data. Sparse because it's only
    // set once registration is completed (see the profile-linking flow).
    supabaseUserId: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
    },
    username: {
      type: String,
      required: [true, 'Username is required'],
      unique: true,
      trim: true,
      minlength: [3, 'Username must be at least 3 characters'],
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email'],
    },
    role: {
      type: String,
      enum: ['patient', 'dietician', 'admin'],
      default: 'patient',
    },

    // Personal Information (Screen 1)
    profile: {
      fullName: {
        type: String,
        required: false,
        trim: true,
      },
      gender: {
        type: String,
        enum: ['Male', 'Female', 'Other'],
        required: false,
      },
      dateOfBirth: {
        type: Date,
        required: false,
      },
      whatsappNumber: {
        type: String,
        required: false,
        trim: true,
      },
      profileImage: { type: String },
    },

    // Health Profile (Screens 1-5)
    healthProfile: {
      // Physical measurements
      weight: {
        type: Number,
        required: false,
      }, // in kg
      height: {
        type: Number,
        required: false,
      }, // in cm
      bmi: {
        type: Number,
        required: [true, 'BMI is required'],
      }, // calculated: weight / (height/100)^2
      weightIndex: {
        type: Number,
        enum: [0, 1, 2, 3], // 0 = Normal, 1 = Underweight, 2 = Overweight, 3 = Obese
        required: [true, 'Weight index is required'],
      },
      bmiCategory: {
        type: String,
        enum: ['Underweight', 'Normal', 'Overweight', 'Obese'],
      },

      // Goal (Screen 1 & 2)
      primaryGoal: {
        type: String,
        enum: [
          'Weight Loss',
          'Weight Gain',
          'Weight Maintenance',
          'Muscle Gain (Body Recomposition)',
          'Fat Loss',
          'Healthy Weight Management',
        ],
        required: false,
      },
      targetWeight: {
        type: String,
        required: false,
      }, // in kg

      // Activity Level (Screen 3)
      activityLevel: {
        type: String,
        enum: ['Sedentary', 'Lightly Activity', 'Moderately Activity', 'Very Active'],
        required: false,
      },

      // Health Concerns (Screen 4) - Multiple selection
      healthConcerns: [
        {
          type: String,
          enum: [
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
            'Other',
          ],
        },
      ],
    },

    status: {
      firstConsultationId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'FirstConsultation',
        default: null,
      },
      // Set once the patient has reviewed the dietician-filled first
      // consultation and submitted the Consent & Confidentiality section
      // themselves - gates the dietician's "Create Diet Plan" button.
      patientConsented: {
        type: Boolean,
        default: false,
      },
      activeDietPlanId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'DietPlan',
        default: null,
      },
      requestId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'DietPlanRequest',
        default: null,
      },
      requestStatus: {
        type: String,
        default: null,
      },
      canSendPaymentRequest: {
        type: Boolean,
        default: false,
      },
      hasPaymentUpdate: {
        type: Boolean,
        default: false,
      },
      subscriptionExpiresAt: {
        type: Date,
        default: null,
      },
    },

    isVerified: {
      type: Boolean,
      default: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },

    // Dietician-specific fields (for future use)
    dieticianProfile: {
      specialization: { type: String },
      experience: { type: Number }, // in years
      qualification: { type: String },
      bio: { type: String },
      isApproved: { type: Boolean, default: false },
    },

    // For tracking
    lastLogin: Date,
    deviceToken: String, // For push notifications
  },
  {
    timestamps: true,
  }
);

// Calculate BMI metrics before validation so required fields stay in sync
userSchema.pre('validate', function () {
  if (!this.healthProfile) {
    return;
  }

  const hp = this.healthProfile;
  const hasMeasurements = typeof hp.weight === 'number' && typeof hp.height === 'number';
  const hasBmi = typeof hp.bmi === 'number' && !Number.isNaN(hp.bmi);

  // Only calculate BMI when the frontend did not send one but we have weight/height
  if (!hasBmi && hasMeasurements) {
    const heightInMeters = hp.height / 100;
    const calculatedBmi = hp.weight / (heightInMeters * heightInMeters);
    hp.bmi = parseFloat(calculatedBmi.toFixed(1));
  }

  const bmi = typeof hp.bmi === 'number' && !Number.isNaN(hp.bmi) ? hp.bmi : undefined;
  const hasWeightIndex = hp.weightIndex === 0 || hp.weightIndex === 1 || hp.weightIndex === 2;

  // Weight index defaults to BMI mapping when not provided
  if (!hasWeightIndex && bmi !== undefined) {
    if (bmi < 18.5) {
      hp.weightIndex = 1;
    } else if (bmi < 25) {
      hp.weightIndex = 0;
    } else {
      hp.weightIndex = 2;
    }
  }

  // Always maintain BMI category for downstream logic when BMI exists
  if (bmi !== undefined) {
    if (bmi < 18.5) {
      hp.bmiCategory = 'Underweight';
    } else if (bmi < 25) {
      hp.bmiCategory = 'Normal';
    } else if (bmi < 30) {
      hp.bmiCategory = 'Overweight';
    } else {
      hp.bmiCategory = 'Obese';
    }
  }
});

// Format dates for frontend (DD-MM-YYYY)
userSchema.set('toJSON', {
  transform: function (doc, ret) {
    // Format profile.dateOfBirth
    if (ret.profile && ret.profile.dateOfBirth) {
      const d = new Date(ret.profile.dateOfBirth);
      if (!isNaN(d.getTime())) {
        // 15-05-1995
        const day = String(d.getDate()).padStart(2, '0');
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const year = d.getFullYear();
        ret.profile.dateOfBirth = `${day}-${month}-${year}`;
      }
    }
    return ret;
  },
  virtuals: true,
});

module.exports = mongoose.model('User', userSchema);
