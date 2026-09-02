const mongoose = require('mongoose');

const firstConsultationSchema = new mongoose.Schema(
  {
    patient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    dietician: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    dietaryHabitsAllergies: {
      currentEatingStyle: {
        options: { type: [String], default: [] },
        otherInfo: { type: String, default: '' },
      },
      allergiesIntolerances: {
        options: { type: [String], default: [] },
        otherInfo: { type: String, default: '' },
      },
      foodsToAvoid: {
        text: { type: String, default: '' },
      },
      cravings: {
        options: { type: [String], default: [] },
      },
      whoCooksMeals: {
        options: { type: [String], default: [] },
      },
      waterIntake: { type: String, default: '' },
      alcoholOrSmoking: {
        uses: { type: String, default: '' },
        frequency: { type: String, default: '' },
      },
    },
    femaleSpecificHealth: {
      isApplicable: { type: Boolean, default: false },
      periodsRegular: { type: String, default: '' },
      issues: { type: [String], default: [] },
      onMedications: { type: [String], default: [] },
    },
    digestionElimination: {
      symptoms: { type: [String], default: [] },
      bowelFrequency: { type: String, default: '' },
    },
    sleepStress: {
      sleepDuration: { type: String, default: '' },
      sleepQuality: { type: [String], default: [] },
      stressLevel: { type: String, default: '' },
      mentalHealthCondition: { type: String, default: '' },
      mentalHealthNotes: { type: String, default: '' },
    },
    medicationSupplements: {
      onMedication: {
        answer: { type: String, default: '' },
        details: { type: String, default: '' },
      },
      supplements: {
        options: { type: [String], default: [] },
        other: { type: String, default: '' },
      },
    },
    labReports: {
      files: { type: [String], default: [] },
    },
    finalNotes: {
      concerns: { type: String, default: '' },
      readinessToCommit: { type: String, default: '' },
    },
    // Answers to the dietician's custom consultation form (per ConsultationFormTemplate)
    customAnswers: {
      type: [
        {
          fieldId: { type: String, required: true },
          label: { type: String, default: '' },
          type: { type: String, default: 'text' },
          // Mixed to support strings, numbers, booleans, arrays (multiChoice)
          value: { type: mongoose.Schema.Types.Mixed, default: null },
          _id: false,
        },
      ],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

// Cross-app performance optimization, Phase 2: every read is
// findOne({ patient }).sort({ createdAt }) (both directions) - see
// firstConsultationController (patient + dietician sides) and
// patientController.getPatientProfile. Previously unindexed (COLLSCAN).
firstConsultationSchema.index({ patient: 1, createdAt: 1 });

module.exports = mongoose.model('FirstConsultation', firstConsultationSchema);
