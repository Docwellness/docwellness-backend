const validationError = (message) => {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
};

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const ensureString = (value, label) => {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw validationError(`${label} must be a string`);
  }
  return value;
};

const ensureBoolean = (value, label) => {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw validationError(`${label} must be a boolean`);
  }
  return value;
};

const ensureStringArray = (value, label) => {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw validationError(`${label} must be an array of strings`);
  }
  return value;
};

const sanitizeDietaryHabitsAllergies = (input) => {
  if (!isPlainObject(input)) {
    return null;
  }

  const section = {};

  if (isPlainObject(input.currentEatingStyle)) {
    const current = {};
    const options = ensureStringArray(
      input.currentEatingStyle.options,
      'dietaryHabitsAllergies.currentEatingStyle.options'
    );
    if (options !== undefined) {
      current.options = options;
    }
    const otherInfo = ensureString(
      input.currentEatingStyle.otherInfo,
      'dietaryHabitsAllergies.currentEatingStyle.otherInfo'
    );
    if (otherInfo !== undefined) {
      current.otherInfo = otherInfo;
    }
    if (Object.keys(current).length) {
      section.currentEatingStyle = current;
    }
  }

  if (isPlainObject(input.allergiesIntolerances)) {
    const allergies = {};
    const options = ensureStringArray(
      input.allergiesIntolerances.options,
      'dietaryHabitsAllergies.allergiesIntolerances.options'
    );
    if (options !== undefined) {
      allergies.options = options;
    }
    const otherInfo = ensureString(
      input.allergiesIntolerances.otherInfo,
      'dietaryHabitsAllergies.allergiesIntolerances.otherInfo'
    );
    if (otherInfo !== undefined) {
      allergies.otherInfo = otherInfo;
    }
    if (Object.keys(allergies).length) {
      section.allergiesIntolerances = allergies;
    }
  }

  if (isPlainObject(input.foodsToAvoid)) {
    const text = ensureString(
      input.foodsToAvoid.text,
      'dietaryHabitsAllergies.foodsToAvoid.text'
    );
    if (text !== undefined) {
      section.foodsToAvoid = { text };
    }
  }

  if (isPlainObject(input.cravings)) {
    const options = ensureStringArray(
      input.cravings.options,
      'dietaryHabitsAllergies.cravings.options'
    );
    if (options !== undefined) {
      section.cravings = { options };
    }
  }

  if (isPlainObject(input.whoCooksMeals)) {
    const options = ensureStringArray(
      input.whoCooksMeals.options,
      'dietaryHabitsAllergies.whoCooksMeals.options'
    );
    if (options !== undefined) {
      section.whoCooksMeals = { options };
    }
  }

  const waterIntake = ensureString(input.waterIntake, 'dietaryHabitsAllergies.waterIntake');
  if (waterIntake !== undefined) {
    section.waterIntake = waterIntake;
  }

  if (isPlainObject(input.alcoholOrSmoking)) {
    const alcohol = {};
    const uses = ensureString(
      input.alcoholOrSmoking.uses,
      'dietaryHabitsAllergies.alcoholOrSmoking.uses'
    );
    if (uses !== undefined) {
      alcohol.uses = uses;
    }
    const frequency = ensureString(
      input.alcoholOrSmoking.frequency,
      'dietaryHabitsAllergies.alcoholOrSmoking.frequency'
    );
    if (frequency !== undefined) {
      alcohol.frequency = frequency;
    }
    if (Object.keys(alcohol).length) {
      section.alcoholOrSmoking = alcohol;
    }
  }

  return Object.keys(section).length ? section : null;
};

const sanitizeFemaleSpecificHealth = (input) => {
  if (!isPlainObject(input)) {
    return null;
  }

  const section = {};
  const isApplicable = ensureBoolean(input.isApplicable, 'femaleSpecificHealth.isApplicable');
  if (isApplicable !== undefined) {
    section.isApplicable = isApplicable;
    if (isApplicable === false) {
      return section;
    }
  }

  const periodsRegular = ensureString(input.periodsRegular, 'femaleSpecificHealth.periodsRegular');
  if (periodsRegular !== undefined) {
    section.periodsRegular = periodsRegular;
  }

  const issues = ensureStringArray(input.issues, 'femaleSpecificHealth.issues');
  if (issues !== undefined) {
    section.issues = issues;
  }

  const onMedications = ensureStringArray(
    input.onMedications,
    'femaleSpecificHealth.onMedications'
  );
  if (onMedications !== undefined) {
    section.onMedications = onMedications;
  }

  return Object.keys(section).length ? section : null;
};

const sanitizeDigestionElimination = (input) => {
  if (!isPlainObject(input)) {
    return null;
  }

  const section = {};
  const symptoms = ensureStringArray(input.symptoms, 'digestionElimination.symptoms');
  if (symptoms !== undefined) {
    section.symptoms = symptoms;
  }
  const bowelFrequency = ensureString(input.bowelFrequency, 'digestionElimination.bowelFrequency');
  if (bowelFrequency !== undefined) {
    section.bowelFrequency = bowelFrequency;
  }
  return Object.keys(section).length ? section : null;
};

const sanitizeSleepStress = (input) => {
  if (!isPlainObject(input)) {
    return null;
  }

  const section = {};
  const sleepDuration = ensureString(input.sleepDuration, 'sleepStress.sleepDuration');
  if (sleepDuration !== undefined) {
    section.sleepDuration = sleepDuration;
  }
  const sleepQuality = ensureStringArray(input.sleepQuality, 'sleepStress.sleepQuality');
  if (sleepQuality !== undefined) {
    section.sleepQuality = sleepQuality;
  }
  const stressLevel = ensureString(input.stressLevel, 'sleepStress.stressLevel');
  if (stressLevel !== undefined) {
    section.stressLevel = stressLevel;
  }
  const mentalHealthCondition = ensureString(
    input.mentalHealthCondition,
    'sleepStress.mentalHealthCondition'
  );
  if (mentalHealthCondition !== undefined) {
    section.mentalHealthCondition = mentalHealthCondition;
  }
  const mentalHealthNotes = ensureString(
    input.mentalHealthNotes,
    'sleepStress.mentalHealthNotes'
  );
  if (mentalHealthNotes !== undefined) {
    section.mentalHealthNotes = mentalHealthNotes;
  }

  return Object.keys(section).length ? section : null;
};

const sanitizeMedicationSupplements = (input) => {
  if (!isPlainObject(input)) {
    return null;
  }

  const section = {};

  if (isPlainObject(input.onMedication)) {
    const onMedication = {};
    const answer = ensureString(
      input.onMedication.answer,
      'medicationSupplements.onMedication.answer'
    );
    if (answer !== undefined) {
      onMedication.answer = answer;
    }
    const details = ensureString(
      input.onMedication.details,
      'medicationSupplements.onMedication.details'
    );
    if (details !== undefined) {
      onMedication.details = details;
    }
    if (Object.keys(onMedication).length) {
      section.onMedication = onMedication;
    }
  }

  if (isPlainObject(input.supplements)) {
    const supplements = {};
    const options = ensureStringArray(
      input.supplements.options,
      'medicationSupplements.supplements.options'
    );
    if (options !== undefined) {
      supplements.options = options;
    }
    const other = ensureString(
      input.supplements.other,
      'medicationSupplements.supplements.other'
    );
    if (other !== undefined) {
      supplements.other = other;
    }
    if (Object.keys(supplements).length) {
      section.supplements = supplements;
    }
  }

  return Object.keys(section).length ? section : null;
};

const sanitizeLabReports = (input) => {
  if (!isPlainObject(input)) {
    return null;
  }
  const files = ensureStringArray(input.files, 'labReports.files');
  if (files === undefined) {
    return null;
  }
  return { files };
};

const sanitizeFinalNotes = (input) => {
  if (!isPlainObject(input)) {
    return null;
  }
  const section = {};
  const concerns = ensureString(input.concerns, 'finalNotes.concerns');
  if (concerns !== undefined) {
    section.concerns = concerns;
  }
  const readiness = ensureString(input.readinessToCommit, 'finalNotes.readinessToCommit');
  if (readiness !== undefined) {
    section.readinessToCommit = readiness;
  }
  return Object.keys(section).length ? section : null;
};

const buildFirstConsultationPayload = (body = {}) => {
  const payload = {};

  const dietaryHabitsAllergies = sanitizeDietaryHabitsAllergies(body.dietaryHabitsAllergies);
  if (dietaryHabitsAllergies) {
    payload.dietaryHabitsAllergies = dietaryHabitsAllergies;
  }

  const femaleSpecificHealth = sanitizeFemaleSpecificHealth(body.femaleSpecificHealth);
  if (femaleSpecificHealth) {
    payload.femaleSpecificHealth = femaleSpecificHealth;
  }

  const digestionElimination = sanitizeDigestionElimination(body.digestionElimination);
  if (digestionElimination) {
    payload.digestionElimination = digestionElimination;
  }

  const sleepStress = sanitizeSleepStress(body.sleepStress);
  if (sleepStress) {
    payload.sleepStress = sleepStress;
  }

  const medicationSupplements = sanitizeMedicationSupplements(body.medicationSupplements);
  if (medicationSupplements) {
    payload.medicationSupplements = medicationSupplements;
  }

  const labReports = sanitizeLabReports(body.labReports);
  if (labReports) {
    payload.labReports = labReports;
  }

  const finalNotes = sanitizeFinalNotes(body.finalNotes);
  if (finalNotes) {
    payload.finalNotes = finalNotes;
  }

  return payload;
};

const flattenPayload = (obj, parentKey = '', acc = {}) => {
  Object.entries(obj || {}).forEach(([key, value]) => {
    const newKey = parentKey ? `${parentKey}.${key}` : key;
    if (isPlainObject(value)) {
      flattenPayload(value, newKey, acc);
    } else {
      acc[newKey] = value;
    }
  });
  return acc;
};

module.exports = {
  buildFirstConsultationPayload,
  flattenPayload,
};
