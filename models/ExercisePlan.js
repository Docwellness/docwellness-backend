const mongoose = require('mongoose');

// A patient's dietician-assigned exercise plan - deliberately a slimmer
// sibling of DietPlan.js. DietPlan's weekSchedule[]/cycleNumber/
// finalizedPlan machinery exists to solve its own 4-week-renewal problem;
// nothing here needs that yet, so this is a flat, evergreen
// dailyExercises[] list, edited in place, keyed by the same day-group
// rotation diet plans already use (see utils/dayGroups.js) rather than a
// week-cycled structure. Extend to a DietPlan-shaped weekly structure only
// if real usage shows the evergreen rotation isn't enough (see the Exercise
// Plan feature plan's Phase 2).
const exercisePlanSchema = new mongoose.Schema(
  {
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    dieticianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    status: {
      type: String,
      enum: ['Draft', 'Active', 'Completed'],
      default: 'Draft',
    },
    startDate: {
      type: Date,
      default: Date.now,
    },
    // null = ongoing/no end date.
    endDate: {
      type: Date,
      default: null,
    },
    dailyExercises: {
      type: [
        {
          exerciseId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Exercise',
            required: true,
          },
          // Optional - a suggested/target duration that pre-fills the
          // patient's log dialog. When `sets` is also set on this entry,
          // this is the duration PER SET (total = durationMinutes * sets) -
          // when `sets` is null, it's already a flat total (e.g. "10 min
          // jump rope"). The patient's own actual duration at log time
          // takes priority when given; when the patient leaves it blank,
          // this figure (or, failing that, the exercise catalog's
          // secondsPerRep - see utils/exerciseHelpers.js's
          // estimateDurationMinutes) is what estimates caloriesBurned - see
          // submitExerciseLog.
          durationMinutes: {
            type: Number,
            default: null,
            min: 1,
          },
          sets: {
            type: Number,
            default: null,
          },
          reps: {
            type: Number,
            default: null,
          },
          // One of utils/dayGroups.js's DAY_GROUPS ('Monday'/'Tuesday'/
          // 'Wednesday'/'Thursday') - same Monday=Friday, Tuesday=Saturday,
          // Wednesday=Sunday, Thursday-unique rotation diet plans use, so
          // "today's assigned exercises" resolves via the same
          // resolveDayGroupForDate/mealMatchesDayGroup utilities already
          // proven by the diet-plan read path.
          dayGroup: {
            type: String,
            enum: ['Monday', 'Tuesday', 'Wednesday', 'Thursday'],
            required: true,
          },
        },
      ],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

// {patientId, status:'Active'} is the dominant query shape (mirrors
// DietPlan's own index rationale).
exercisePlanSchema.index({ patientId: 1, status: 1 });

module.exports = mongoose.model('ExercisePlan', exercisePlanSchema);
