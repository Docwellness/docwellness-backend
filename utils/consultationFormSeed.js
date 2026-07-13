/**
 * Default "First Consultation" questionnaire content, seeded into a
 * dietician's ConsultationFormTemplate the first time they open the form
 * with no template of their own (see consultationFormController.js's
 * getMyTemplate). Sourced from DocWellness_Nutrition_Intake_Questionnaire.
 *
 * fieldIds are hand-assigned and must stay stable - they're the join key for
 * FirstConsultation.customAnswers entries, for dependsOnFieldId references
 * within this file, and (for SAFETY_FIELD_IDS) for the AI diet-plan
 * allergy/diet hard-filter and prompt-injection guardrail in
 * dietPlanController.js.
 */

// Fields whose answers feed safety-critical logic downstream - do not rename
// without also updating dietPlanController.js.
const SAFETY_FIELD_IDS = {
  EATING_STYLE: 'diet_eating_style',
  ALLERGIES: 'diet_allergies_intolerances',
  ALLERGIES_OTHER: 'diet_allergies_other_specify',
  FOODS_TO_AVOID: 'diet_foods_to_avoid',
  FINAL_NOTES_CONCERNS: 'final_notes_concerns',
};

let _order = 0;
const next = () => _order++;

const field = (overrides) => ({
  fieldId: overrides.fieldId,
  type: overrides.type,
  label: overrides.label,
  options: overrides.options || [],
  required: overrides.required || false,
  order: next(),
  section: overrides.section || '',
  genderScope: overrides.genderScope || 'general',
  dependsOnFieldId: overrides.dependsOnFieldId || null,
  dependsOnValues: overrides.dependsOnValues || [],
});

const SECTIONS = {
  CONSENT: 'Consent & Confidentiality',
  LIFESTYLE: '1. Personal & Lifestyle Details',
  GOALS: '2. Consultation Goals & Readiness',
  ANTHRO: '3. Anthropometry & Weight History',
  MEDHX: '4. Medical History',
  FAMHX: '5. Family History of Chronic Disease',
  DIET: '6. Dietary Habits, Allergies & Cultural Practices',
  FASTING: '7. Cultural & Religious Fasting Practices',
  DIGESTION: '8. Digestion & Elimination',
  ACTIVITY: '9. Physical Activity',
  SLEEP: '10. Sleep & Stress',
  FEMALE: '11. Female-Specific Health',
  MALE: '12. Male-Specific Health',
  EATING_BEHAVIOR: '13. Eating Behaviour & Emotional Wellbeing',
  MEDS: '14. Medication & Supplements',
  LABS: '15. Lab Reports',
  FINAL: '16. Final Notes',
};

const DEFAULT_CONSULTATION_FORM_FIELDS = [
  // Consent
  field({
    fieldId: 'consent_acknowledgement',
    type: 'multiChoice',
    label: 'I have read and understood the above, and I consent to share this information for my nutrition consultation.',
    options: ['I consent'],
    required: true,
    section: SECTIONS.CONSENT,
  }),
  field({
    fieldId: 'consent_signature_name',
    type: 'text',
    label: 'Signature (type your full name)',
    required: true,
    section: SECTIONS.CONSENT,
  }),

  // 1. Personal & Lifestyle Details
  field({ fieldId: 'lifestyle_occupation', type: 'text', label: 'Occupation', section: SECTIONS.LIFESTYLE }),
  field({ fieldId: 'lifestyle_work_hours', type: 'text', label: 'Work hours/day', section: SECTIONS.LIFESTYLE }),
  field({
    fieldId: 'lifestyle_work_pattern',
    type: 'singleChoice',
    label: 'Does your work involve shift work, night shifts, or frequent travel?',
    options: ['Regular daytime hours', 'Shift work / night shifts', 'Frequent travel', 'Not applicable'],
    section: SECTIONS.LIFESTYLE,
  }),
  field({
    fieldId: 'lifestyle_who_cooks',
    type: 'singleChoice',
    label: 'Who cooks your meals?',
    options: ['Self', 'Family', 'Hired help', 'Eat out / food delivery'],
    section: SECTIONS.LIFESTYLE,
  }),
  field({
    fieldId: 'lifestyle_who_you_live_with',
    type: 'text',
    label: 'Who else do you live with (family / alone / hostel, etc.)',
    section: SECTIONS.LIFESTYLE,
  }),

  // 2. Consultation Goals & Readiness
  field({
    fieldId: 'goals_primary_goal',
    type: 'textarea',
    label: 'What brings you to this consultation? What is your primary goal?',
    section: SECTIONS.GOALS,
  }),
  field({
    fieldId: 'goals_other_concerns',
    type: 'textarea',
    label: "Are there any other specific concerns you'd like to address?",
    section: SECTIONS.GOALS,
  }),
  field({
    fieldId: 'goals_readiness',
    type: 'singleChoice',
    label: 'Are you ready to commit to a personalized nutrition plan?',
    options: ['Yes', 'Maybe', 'Not yet'],
    section: SECTIONS.GOALS,
  }),

  // 3. Anthropometry & Weight History
  field({ fieldId: 'anthro_height', type: 'number', label: 'Height (cm)', section: SECTIONS.ANTHRO }),
  field({ fieldId: 'anthro_current_weight', type: 'number', label: 'Current weight (kg)', section: SECTIONS.ANTHRO }),
  field({ fieldId: 'anthro_highest_weight', type: 'number', label: 'Highest-ever adult weight (kg)', section: SECTIONS.ANTHRO }),
  field({ fieldId: 'anthro_lowest_weight', type: 'number', label: 'Lowest adult weight (kg)', section: SECTIONS.ANTHRO }),
  field({
    fieldId: 'anthro_weight_change',
    type: 'singleChoice',
    label: 'Any unintentional weight change in the last 6 months?',
    options: ['Gain', 'Loss', 'No change'],
    section: SECTIONS.ANTHRO,
  }),
  field({
    fieldId: 'anthro_weight_change_amount',
    type: 'text',
    label: 'If gain/loss, approximate amount',
    section: SECTIONS.ANTHRO,
    dependsOnFieldId: 'anthro_weight_change',
    dependsOnValues: ['Gain', 'Loss'],
  }),
  field({
    fieldId: 'anthro_diet_history',
    type: 'textarea',
    label: "Have you tried any specific diets or weight-management plans before? What worked or didn't work?",
    section: SECTIONS.ANTHRO,
  }),

  // 4. Medical History
  field({
    fieldId: 'medhx_conditions',
    type: 'multiChoice',
    label: 'Do you have any diagnosed medical conditions?',
    options: [
      'Diabetes', 'Hypertension', 'Thyroid disorder', 'Heart disease',
      'High cholesterol', 'Kidney disease', 'Liver disease', 'PCOS / PCOD',
      'None', 'Other',
    ],
    section: SECTIONS.MEDHX,
  }),
  field({
    fieldId: 'medhx_conditions_other',
    type: 'text',
    label: 'If other, please specify',
    section: SECTIONS.MEDHX,
    dependsOnFieldId: 'medhx_conditions',
    dependsOnValues: ['Other'],
  }),
  field({
    fieldId: 'medhx_surgeries',
    type: 'textarea',
    label: 'Any past surgeries relevant to digestion or nutrition (e.g. gallbladder, bariatric)?',
    section: SECTIONS.MEDHX,
  }),

  // 5. Family History of Chronic Disease
  field({
    fieldId: 'famhx_conditions',
    type: 'multiChoice',
    label: 'Do any of your immediate family members (parents / siblings) have any of the following?',
    options: [
      'Diabetes', 'Hypertension', 'Heart disease / Stroke', 'Thyroid disorder',
      'High cholesterol', 'Obesity', 'Cancer (please specify)', 'None known',
    ],
    section: SECTIONS.FAMHX,
  }),
  field({
    fieldId: 'famhx_cancer_type',
    type: 'text',
    label: 'If cancer, please specify type',
    section: SECTIONS.FAMHX,
    dependsOnFieldId: 'famhx_conditions',
    dependsOnValues: ['Cancer (please specify)'],
  }),

  // 6. Dietary Habits, Allergies & Cultural Practices
  field({
    fieldId: SAFETY_FIELD_IDS.EATING_STYLE,
    type: 'singleChoice',
    label: 'Current eating style',
    options: ['Vegetarian', 'Non-Vegetarian', 'Vegan', 'Eggetarian', 'Jain'],
    section: SECTIONS.DIET,
    required: true,
  }),
  field({
    fieldId: 'diet_vegetarian_subtype',
    type: 'singleChoice',
    label: 'If vegetarian, which best describes you?',
    options: ['Lacto-vegetarian', 'Lacto-ovo vegetarian', 'Pure veg (no onion/garlic)', 'Sattvic'],
    section: SECTIONS.DIET,
    dependsOnFieldId: SAFETY_FIELD_IDS.EATING_STYLE,
    dependsOnValues: ['Vegetarian'],
  }),
  field({
    fieldId: 'diet_cuisine',
    type: 'singleChoice',
    label: 'Which cuisine do you eat most regularly?',
    options: ['North Indian', 'South Indian', 'East Indian', 'West Indian', 'Mixed / Other'],
    section: SECTIONS.DIET,
  }),
  field({
    fieldId: SAFETY_FIELD_IDS.ALLERGIES,
    type: 'multiChoice',
    label: 'Do you have any allergies or intolerances?',
    options: ['Gluten', 'Dairy / Lactose', 'Nuts', 'Eggs', 'Seafood', 'Soy', 'Sesame', 'Other'],
    section: SECTIONS.DIET,
  }),
  field({
    fieldId: SAFETY_FIELD_IDS.ALLERGIES_OTHER,
    type: 'text',
    label: 'If other, please specify',
    section: SECTIONS.DIET,
    dependsOnFieldId: SAFETY_FIELD_IDS.ALLERGIES,
    dependsOnValues: ['Other'],
  }),
  field({
    fieldId: SAFETY_FIELD_IDS.FOODS_TO_AVOID,
    type: 'textarea',
    label: 'What foods do you avoid for religious, cultural, or personal reasons?',
    section: SECTIONS.DIET,
  }),
  field({
    fieldId: 'diet_cooking_oils',
    type: 'multiChoice',
    label: 'Which cooking oils/fats do you use at home?',
    options: [
      'Mustard oil', 'Groundnut oil', 'Sunflower / refined oil', 'Coconut oil',
      'Sesame oil', 'Ghee', 'Vanaspati / Dalda', 'Other',
    ],
    section: SECTIONS.DIET,
  }),
  field({
    fieldId: 'diet_cooking_oils_other',
    type: 'text',
    label: 'If other, please specify',
    section: SECTIONS.DIET,
    dependsOnFieldId: 'diet_cooking_oils',
    dependsOnValues: ['Other'],
  }),
  field({ fieldId: 'diet_meals_per_day', type: 'number', label: 'How many meals do you eat per day', section: SECTIONS.DIET }),
  field({ fieldId: 'diet_tea_coffee_cups', type: 'number', label: 'Cups of tea/coffee per day', section: SECTIONS.DIET }),
  field({
    fieldId: 'diet_skip_meals',
    type: 'singleChoice',
    label: 'Do you typically skip meals?',
    options: ['Never', 'Sometimes', 'Often'],
    section: SECTIONS.DIET,
  }),
  field({
    fieldId: 'diet_skip_meals_which',
    type: 'text',
    label: 'If sometimes/often, which meal is usually skipped',
    section: SECTIONS.DIET,
    dependsOnFieldId: 'diet_skip_meals',
    dependsOnValues: ['Sometimes', 'Often'],
  }),
  field({
    fieldId: 'diet_snack_frequency',
    type: 'singleChoice',
    label: 'How often do you snack between meals?',
    options: ['Rarely', 'Sometimes', 'Frequently'],
    section: SECTIONS.DIET,
  }),
  field({
    fieldId: 'diet_snack_triggers',
    type: 'multiChoice',
    label: 'What usually triggers your snacking?',
    options: ['Hunger', 'Boredom', 'Stress', 'Social occasions'],
    section: SECTIONS.DIET,
  }),
  field({
    fieldId: 'diet_eating_out_frequency',
    type: 'singleChoice',
    label: 'How often do you eat out or order food delivery?',
    options: ['Daily', 'Few times a week', 'Weekly', 'Rarely'],
    section: SECTIONS.DIET,
  }),
  field({
    fieldId: 'diet_cravings',
    type: 'multiChoice',
    label: 'Cravings you struggle with',
    options: ['Sugar', 'Salt', 'Fried foods', 'Processed snacks'],
    section: SECTIONS.DIET,
  }),
  field({ fieldId: 'diet_water_intake', type: 'number', label: 'Water intake (liters/day)', section: SECTIONS.DIET }),
  field({
    fieldId: 'diet_alcohol_smoking',
    type: 'yesNo',
    label: 'Do you consume alcohol, smoke, or use tobacco/paan?',
    section: SECTIONS.DIET,
  }),
  field({
    fieldId: 'diet_alcohol_smoking_details',
    type: 'text',
    label: 'If yes, please specify type and frequency',
    section: SECTIONS.DIET,
    dependsOnFieldId: 'diet_alcohol_smoking',
    dependsOnValues: ['Yes'],
  }),

  // 7. Cultural & Religious Fasting Practices
  field({
    fieldId: 'fasting_observed',
    type: 'multiChoice',
    label: 'Do you observe any regular fasts?',
    options: [
      'Navratri', 'Ekadashi', 'Karva Chauth', 'Maha Shivratri', 'Janmashtami',
      'Paryushan (Jain)', 'Ramadan', 'Weekly vrat', 'Other', 'None',
    ],
    section: SECTIONS.FASTING,
  }),
  field({
    fieldId: 'fasting_weekly_vrat_day',
    type: 'text',
    label: 'If weekly vrat, which day(s)',
    section: SECTIONS.FASTING,
    dependsOnFieldId: 'fasting_observed',
    dependsOnValues: ['Weekly vrat'],
  }),
  field({
    fieldId: 'fasting_behavior',
    type: 'singleChoice',
    label: 'During your fast, what do you typically do?',
    options: ['Avoid grains only', 'Eat fruits/milk (phalahar)', 'Avoid water entirely (nirjala)', 'Other'],
    section: SECTIONS.FASTING,
  }),
  field({
    fieldId: 'fasting_frequency_duration',
    type: 'text',
    label: 'Typical frequency and duration of fasting',
    section: SECTIONS.FASTING,
  }),

  // 8. Digestion & Elimination
  field({
    fieldId: 'digestion_symptoms',
    type: 'multiChoice',
    label: 'Do you experience any of the following?',
    options: ['Constipation', 'Loose stools', 'Gas / Bloating', 'Acidity', 'Indigestion'],
    section: SECTIONS.DIGESTION,
  }),
  field({
    fieldId: 'digestion_bowel_frequency',
    type: 'singleChoice',
    label: 'Frequency of bowel movements',
    options: ['Daily', 'Irregular'],
    section: SECTIONS.DIGESTION,
  }),

  // 9. Physical Activity
  field({ fieldId: 'activity_days_per_week', type: 'number', label: 'Days per week you exercise (moderate–strenuous)', section: SECTIONS.ACTIVITY }),
  field({ fieldId: 'activity_minutes_per_session', type: 'number', label: 'Minutes per session', section: SECTIONS.ACTIVITY }),
  field({
    fieldId: 'activity_type',
    type: 'multiChoice',
    label: 'Type of activity',
    options: ['Walking', 'Gym / Weights', 'Yoga', 'Sports', 'None', 'Other'],
    section: SECTIONS.ACTIVITY,
  }),
  field({
    fieldId: 'activity_daytoday_level',
    type: 'singleChoice',
    label: 'How would you describe your day-to-day activity level at work?',
    options: ['Mostly sitting', 'Mostly standing / walking', 'Physically strenuous'],
    section: SECTIONS.ACTIVITY,
  }),
  field({
    fieldId: 'activity_sits_more_than_6h',
    type: 'yesNo',
    label: 'Do you typically sit for more than 6 hours a day?',
    section: SECTIONS.ACTIVITY,
  }),

  // 10. Sleep & Stress
  field({ fieldId: 'sleep_duration', type: 'number', label: 'Average sleep duration (hours/night)', section: SECTIONS.SLEEP }),
  field({ fieldId: 'sleep_quality_score', type: 'number', label: 'On a scale of 0 (terrible) to 10 (excellent), how would you rate your sleep quality over the past week?', section: SECTIONS.SLEEP }),
  field({
    fieldId: 'sleep_quality',
    type: 'singleChoice',
    label: 'Quality of sleep',
    options: ['Restful', 'Interrupted', 'Insomnia'],
    section: SECTIONS.SLEEP,
  }),
  field({
    fieldId: 'sleep_stress_level',
    type: 'singleChoice',
    label: 'Overall stress level',
    options: ['Low', 'Moderate', 'High'],
    section: SECTIONS.SLEEP,
  }),
  field({
    fieldId: 'sleep_control_frequency',
    type: 'singleChoice',
    label: 'In the last month, how often have you felt unable to control the important things in your life?',
    options: ['Never', 'Sometimes', 'Often', 'Very often'],
    section: SECTIONS.SLEEP,
  }),
  field({
    fieldId: 'sleep_mental_health',
    type: 'yesNo',
    label: 'Do you have any diagnosed mental health conditions (anxiety, depression, etc.)?',
    section: SECTIONS.SLEEP,
  }),
  field({
    fieldId: 'sleep_mental_health_notes',
    type: 'textarea',
    label: 'If comfortable, please share more - this stays confidential and helps us support you better.',
    section: SECTIONS.SLEEP,
    dependsOnFieldId: 'sleep_mental_health',
    dependsOnValues: ['Yes'],
  }),

  // 11. Female-Specific Health (Female clients only)
  field({
    fieldId: 'female_periods_regular',
    type: 'yesNo',
    label: 'Are your periods regular?',
    section: SECTIONS.FEMALE,
    genderScope: 'female',
  }),
  field({
    fieldId: 'female_conditions',
    type: 'multiChoice',
    label: 'Do any of the following apply to you?',
    options: [
      'PCOS / PCOD', 'Hormonal acne', 'Irregular or painful periods', 'Fibroids or endometriosis',
      'Breastfeeding', 'Currently pregnant', 'Menopausal / perimenopausal',
      'History of miscarriage or fertility issues', 'None of the above',
    ],
    section: SECTIONS.FEMALE,
    genderScope: 'female',
  }),
  field({
    fieldId: 'female_current_treatments',
    type: 'multiChoice',
    label: 'Are you currently on any of the following?',
    options: ['Birth control pills', 'Hormone Replacement Therapy (HRT)', 'Fertility treatments', 'None'],
    section: SECTIONS.FEMALE,
    genderScope: 'female',
  }),
  field({
    fieldId: 'female_anemia',
    type: 'singleChoice',
    label: 'Have you been diagnosed with anemia or low iron?',
    options: ['Yes', 'No', 'Not sure'],
    section: SECTIONS.FEMALE,
    genderScope: 'female',
  }),
  field({
    fieldId: 'female_supplements',
    type: 'yesNo',
    label: 'Do you currently take iron, calcium, or vitamin D supplements?',
    section: SECTIONS.FEMALE,
    genderScope: 'female',
  }),

  // 12. Male-Specific Health (Male clients only)
  field({
    fieldId: 'male_symptoms',
    type: 'multiChoice',
    label: 'Do you experience any of the following?',
    options: [
      'Decreased libido / sex drive', 'Low energy or fatigue', 'Decreased muscle strength',
      'Reduced enjoyment of life', 'Low mood or irritability', 'Weaker erections',
      'Falling asleep after dinner', 'Decline in work/sports performance', 'None of the above',
    ],
    section: SECTIONS.MALE,
    genderScope: 'male',
  }),
  field({
    fieldId: 'male_urinary_symptoms',
    type: 'multiChoice',
    label: 'Do you experience any urinary symptoms?',
    options: ['Frequent urination', 'Urgency', 'Waking at night to urinate', 'None'],
    section: SECTIONS.MALE,
    genderScope: 'male',
  }),
  field({
    fieldId: 'male_prostate',
    type: 'singleChoice',
    label: 'Have you been diagnosed with a prostate condition, or had a recent PSA test?',
    options: ['Yes', 'No', 'Not sure'],
    section: SECTIONS.MALE,
    genderScope: 'male',
  }),
  field({
    fieldId: 'male_fitness_goals',
    type: 'multiChoice',
    label: 'What are your fitness/body goals?',
    options: ['Muscle gain', 'Fat loss', 'General fitness', 'Strength / performance'],
    section: SECTIONS.MALE,
    genderScope: 'male',
  }),
  field({
    fieldId: 'male_gym_supplements',
    type: 'yesNo',
    label: 'Do you use gym supplements (protein powder, creatine, BCAAs, etc.)?',
    section: SECTIONS.MALE,
    genderScope: 'male',
  }),
  field({
    fieldId: 'male_gym_supplements_specify',
    type: 'text',
    label: 'If yes, please specify',
    section: SECTIONS.MALE,
    genderScope: 'male',
    dependsOnFieldId: 'male_gym_supplements',
    dependsOnValues: ['Yes'],
  }),

  // 13. Eating Behaviour & Emotional Wellbeing (General, optional)
  field({
    fieldId: 'eating_behavior_sick_when_full',
    type: 'yesNo',
    label: 'Do you make yourself sick because you feel uncomfortably full?',
    section: SECTIONS.EATING_BEHAVIOR,
  }),
  field({
    fieldId: 'eating_behavior_lost_control',
    type: 'yesNo',
    label: 'Do you worry that you have lost control over how much you eat?',
    section: SECTIONS.EATING_BEHAVIOR,
  }),
  field({
    fieldId: 'eating_behavior_weight_loss_6kg',
    type: 'yesNo',
    label: 'Have you recently lost more than 6 kg in a 3-month period?',
    section: SECTIONS.EATING_BEHAVIOR,
  }),
  field({
    fieldId: 'eating_behavior_body_image',
    type: 'yesNo',
    label: 'Do you believe yourself to be fat when others say you are too thin?',
    section: SECTIONS.EATING_BEHAVIOR,
  }),
  field({
    fieldId: 'eating_behavior_food_dominates',
    type: 'yesNo',
    label: 'Would you say food dominates your life?',
    section: SECTIONS.EATING_BEHAVIOR,
  }),
  field({
    fieldId: 'eating_behavior_depressed_frequency',
    type: 'singleChoice',
    label: 'Over the past 2 weeks, how often have you felt down, depressed, or hopeless?',
    options: ['Not at all', 'Several days', 'More than half the days', 'Nearly every day'],
    section: SECTIONS.EATING_BEHAVIOR,
  }),
  field({
    fieldId: 'eating_behavior_anxious_frequency',
    type: 'singleChoice',
    label: 'Over the past 2 weeks, how often have you felt nervous, anxious, or on edge?',
    options: ['Not at all', 'Several days', 'More than half the days', 'Nearly every day'],
    section: SECTIONS.EATING_BEHAVIOR,
  }),
  field({
    fieldId: 'eating_behavior_opt_out',
    type: 'multiChoice',
    label: 'I prefer not to answer these questions',
    options: ['I prefer not to answer'],
    section: SECTIONS.EATING_BEHAVIOR,
  }),

  // 14. Medication & Supplements
  field({
    fieldId: 'meds_prescribed',
    type: 'singleChoice',
    label: 'Are you currently taking any prescribed medication?',
    options: ['Yes (please list below)', 'No'],
    section: SECTIONS.MEDS,
  }),
  field({
    fieldId: 'meds_prescribed_list',
    type: 'textarea',
    label: 'Please list your current medications',
    section: SECTIONS.MEDS,
    dependsOnFieldId: 'meds_prescribed',
    dependsOnValues: ['Yes (please list below)'],
  }),
  field({
    fieldId: 'meds_supplements',
    type: 'multiChoice',
    label: 'Do you take any supplements?',
    options: ['Multivitamins', 'Protein powders', 'Omega-3', 'Biotin / Collagen', 'Ayurvedic / Herbal (AYUSH)', 'Other'],
    section: SECTIONS.MEDS,
  }),
  field({
    fieldId: 'meds_supplements_other',
    type: 'text',
    label: 'If other, please specify',
    section: SECTIONS.MEDS,
    dependsOnFieldId: 'meds_supplements',
    dependsOnValues: ['Other'],
  }),

  // 15. Lab Reports (Optional)
  field({
    fieldId: 'labs_upload',
    type: 'file',
    label: 'Attach or upload any recent blood tests, hormone panels, or vitamin-level reports, if available.',
    section: SECTIONS.LABS,
  }),
  field({
    fieldId: 'labs_recent_report_date',
    type: 'text',
    label: 'Date of most recent report (if uploading later)',
    section: SECTIONS.LABS,
  }),

  // 16. Final Notes
  field({
    fieldId: SAFETY_FIELD_IDS.FINAL_NOTES_CONCERNS,
    type: 'textarea',
    label: "Is there anything else you'd like your dietician to know before your first session?",
    section: SECTIONS.FINAL,
  }),
  field({
    fieldId: 'final_preferred_language',
    type: 'text',
    label: 'Preferred language / mode of communication (optional)',
    section: SECTIONS.FINAL,
  }),
];

module.exports = { DEFAULT_CONSULTATION_FORM_FIELDS, SAFETY_FIELD_IDS };
