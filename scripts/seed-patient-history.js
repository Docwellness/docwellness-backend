/**
 * Backfills one prod patient with a backdated diet plan, exercise plan, and
 * N days of meal/exercise logs by driving the real api.docwellness.fit API -
 * never writing Mongo documents directly. Prod's diet plans use the v4.0
 * "plan-item" data model, whose content only exists correctly when built
 * through generate-menu -> finalize-plan-item-week -> activate (the only
 * code path that populates DayPlan/MealSlotPlan/PlanItem/RecipeVersion is
 * services/menuGenerationService.js, reachable only via that live API) - see
 * openspec/changes/seed-patient-history in docwellness-specs for the full
 * rationale.
 *
 * One field this cannot backdate: ExercisePlan.startDate - no endpoint
 * accepts a past value for it. See the companion
 * scripts/patch-exercise-plan-startdate.js, which must run inside Coolify's
 * "Execute Command" console.
 *
 * ── Usage ────────────────────────────────────────────────────────────────
 * Either hand this bearer tokens directly:
 *   DIETICIAN_TOKEN=<dietician bearer token> \
 *   PATIENT_TOKEN=<this patient's own bearer token> \
 *   [TYPESAFE_API_KEY=<TypeSafe key, optional>] \
 *     node scripts/seed-patient-history.js [--execute] ...
 *
 * ...or let it log in itself via DIETICIAN_USERNAME/DIETICIAN_PASSWORD and
 * PATIENT_USERNAME/PATIENT_PASSWORD (read from this repo's own .env, or from
 * ../docwellness-specs/.env if not set here) - same POST /auth/login the
 * apps themselves use ({email, password} -> data.accessToken). Explicit
 * *_TOKEN env vars, if set, always win over logging in.
 *
 *     node scripts/seed-patient-history.js [--execute]
 *       [--email=pawarbhushan08@gmail.com] [--days=5] [--start-date=YYYY-MM-DD]
 *       [--api-base=https://api.docwellness.fit]
 *
 * Dry run by default - every mutating call is printed, never sent, and the
 * script stops simulating once it would need an id that only exists after a
 * real write. Pass --execute to actually perform the writes in order.
 *
 * TYPESAFE_API_KEY drives two decisions via Jev (TypeSafe's fast decision
 * model): which catalog exercises fit each day-group (no automatic
 * generator exists for exercises, unlike meals), and whether each logged
 * meal slot was fully eaten / partially eaten / skipped for that specific
 * day (so 5 days of logs don't look identical). Only recipe/exercise names,
 * calorie numbers, serving-time labels, and a day index are ever sent - never
 * the patient's name or email. If the key is missing or a call fails, the
 * script falls back to a fixed reasonable choice rather than blocking.
 */

const path = require('path');
require('dotenv').config();
// Credentials for this one-off seed commonly live in the sibling specs repo's
// .env rather than this backend's own - load it without overriding anything
// already set (by this repo's own .env or the shell environment).
require('dotenv').config({ path: path.join(__dirname, '..', '..', 'docwellness-specs', '.env') });

const EXECUTE = process.argv.includes('--execute');

function arg(name, fallback) {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}

const API_BASE = arg('api-base', 'https://api.docwellness.fit');
const TARGET_EMAIL = arg('email', 'pawarbhushan08@gmail.com');
const LOG_DAYS = parseInt(arg('days', '5'), 10);
let DIETICIAN_TOKEN = process.env.DIETICIAN_TOKEN || null;
let PATIENT_TOKEN = process.env.PATIENT_TOKEN || null;
const DIETICIAN_USERNAME = process.env.DIETICIAN_USERNAME;
const DIETICIAN_PASSWORD = process.env.DIETICIAN_PASSWORD;
const PATIENT_USERNAME = process.env.PATIENT_USERNAME;
const PATIENT_PASSWORD = process.env.PATIENT_PASSWORD;
const TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY;

const DAY_GROUPS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday'];
// Same mapping as utils/dayGroups.js (JS Date.getUTCDay(): 0=Sunday..6=Saturday).
const WEEKDAY_TO_DAY_GROUP = { 1: 'Monday', 5: 'Monday', 2: 'Tuesday', 6: 'Tuesday', 3: 'Wednesday', 0: 'Wednesday', 4: 'Thursday' };
const dayGroupFor = (date) => WEEKDAY_TO_DAY_GROUP[date.getUTCDay()];

function utcMidnight(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

const START_DATE = (() => {
  const raw = arg('start-date', null);
  if (raw) {
    const d = new Date(`${raw}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime())) throw new Error(`--start-date must be YYYY-MM-DD, got "${raw}"`);
    return d;
  }
  const d = utcMidnight(new Date());
  d.setUTCDate(d.getUTCDate() - LOG_DAYS);
  return d;
})();

const isoDate = (d) => d.toISOString().slice(0, 10);

function dateRange(start, days) {
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    return d;
  });
}

async function apiCall(token, method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> HTTP ${res.status}: ${JSON.stringify(json)}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

const read = (token, path) => apiCall(token, 'GET', path);

async function write(token, method, path, body) {
  console.log(`  ${EXECUTE ? '[EXECUTE]' : '[DRY RUN]'} ${method} ${path}`);
  if (body !== undefined) console.log(`    body: ${JSON.stringify(body)}`);
  if (!EXECUTE) return { __dryRun: true };
  return apiCall(token, method, path, body);
}

async function askJev(state, questions) {
  if (!TYPESAFE_API_KEY) return null;
  try {
    const res = await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TYPESAFE_API_KEY}` },
      body: JSON.stringify({ model: 'jev-latest', state, questions }),
    });
    if (!res.ok) {
      console.warn(`  Jev call failed (HTTP ${res.status}) - using fallback.`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`  Jev call errored (${err.message}) - using fallback.`);
    return null;
  }
}

function section(label) {
  console.log(`\n=== ${label} ===`);
}

// Never logs the password. Reads/writes always happen for real (never
// dry-run-stubbed) - logging in isn't a mutation on patient/plan data.
async function loginAs(role, email, password) {
  console.log(`  Logging in as ${role} (${email})...`);
  const res = await apiCall(null, 'POST', `/api/${role}/auth/login`, { email, password });
  const token = res?.data?.accessToken;
  if (!token) throw new Error(`Login for ${role} (${email}) did not return an accessToken.`);
  return token;
}

async function resolveTokens() {
  if (!DIETICIAN_TOKEN) {
    if (!DIETICIAN_USERNAME || !DIETICIAN_PASSWORD) {
      throw new Error(
        'No DIETICIAN_TOKEN, and DIETICIAN_USERNAME/DIETICIAN_PASSWORD are not both set - cannot authenticate as the dietician.'
      );
    }
    DIETICIAN_TOKEN = await loginAs('dietician', DIETICIAN_USERNAME, DIETICIAN_PASSWORD);
  }
  if (!PATIENT_TOKEN) {
    if (!PATIENT_USERNAME || !PATIENT_PASSWORD) {
      throw new Error(
        'No PATIENT_TOKEN, and PATIENT_USERNAME/PATIENT_PASSWORD are not both set - cannot authenticate as the patient.'
      );
    }
    PATIENT_TOKEN = await loginAs('patient', PATIENT_USERNAME, PATIENT_PASSWORD);
  }
}

// ── 1. Resolve patient + dietician ─────────────────────────────────────────

async function resolveIdentities() {
  section('1. Resolving patient + dietician identities');
  const patientMe = await read(PATIENT_TOKEN, '/api/patient/auth/me');
  const patient = patientMe.data || patientMe.user || patientMe;
  if (String(patient.email || '').toLowerCase() !== TARGET_EMAIL.toLowerCase()) {
    throw new Error(
      `PATIENT_TOKEN belongs to "${patient.email}", not the expected "${TARGET_EMAIL}" - aborting.`
    );
  }
  const dieticianMe = await read(DIETICIAN_TOKEN, '/api/dietician/auth/me');
  const dietician = dieticianMe.data || dieticianMe.user || dieticianMe;
  console.log(`  Patient:   ${patient.email} (${patient._id})`);
  console.log(`  Dietician: ${dietician.email} (${dietician._id})`);
  const { weight, height } = patient.healthProfile || {};
  console.log(`  Patient healthProfile: weight=${weight ?? '(none)'}kg, height=${height ?? '(none)'}cm`);
  return { patientId: String(patient._id), dieticianId: String(dietician._id), weight, height };
}

// ── 2. Onboarding prerequisites ─────────────────────────────────────────────

// The dietician-side patient-profile endpoint enforces assertDieticianOwnsPatient
// (DietPlanRequest.exists({patient, dieticianId})) - a brand-new patient with no
// DietPlanRequest yet 403s there even for the correct (default) dietician. That's
// expected before this function creates the first request, not a real error.
async function getExistingMembershipPlan(patientId) {
  try {
    const profile = await read(DIETICIAN_TOKEN, `/api/dietician/patients/${patientId}/profile`);
    return profile?.data?.status?.membershipPlan || null;
  } catch (err) {
    if (err.status === 403) return null;
    throw err;
  }
}

async function ensureMembershipPlan(patientId, weight, height) {
  section('2a. Diet plan request + membership plan');
  const existingMembership = await getExistingMembershipPlan(patientId);
  if (existingMembership) {
    console.log(`  Already has a membership plan selected (${existingMembership}) - skipping.`);
    return;
  }
  if (typeof weight !== 'number' || typeof height !== 'number') {
    throw new Error(
      `Patient ${patientId} has no weight/height on file (healthProfile.weight/height) - cannot create a DietPlanRequest without them.`
    );
  }
  console.log('  No membership plan found - creating a DietPlanRequest and selecting one.');
  const requestBody = {
    startDateForDiet: isoDate(START_DATE),
    weight,
    height,
  };
  const created = await write(PATIENT_TOKEN, 'POST', '/api/patient/diet-plan-requests', requestBody);
  const requestId = created?.data?.requestId;
  if (!requestId) {
    console.log('  (dry run - no request id yet, cannot simulate the plan-selection call further)');
    return;
  }
  await write(PATIENT_TOKEN, 'PATCH', `/api/patient/diet-plan-requests/${requestId}/plan`, {
    membershipPlan: 'Silver Membership',
    membershipAmount: 999,
  });
}

async function ensureFirstConsultation(patientId) {
  section('2b. First consultation + patient consent');
  const existing = await read(DIETICIAN_TOKEN, `/api/dietician/patients/${patientId}/first-consultation`);
  if (existing?.data?._id) {
    console.log(`  First consultation already exists (${existing.data._id}) - skipping creation.`);
    return existing.data._id;
  }
  console.log('  No first consultation - creating one and submitting patient consent.');
  const created = await write(
    DIETICIAN_TOKEN,
    'PUT',
    `/api/dietician/patients/${patientId}/first-consultation`,
    { customAnswers: [] }
  );
  const consultationId = created?.data?._id;
  await write(PATIENT_TOKEN, 'PUT', '/api/patient/first-consultation/consent', {
    acknowledged: true,
    signatureName: 'Bhushan Pawar',
  });
  return consultationId || null;
}

// ── 3. Diet plan: generate -> menu -> finalize -> activate ────────────────

const CALORIE_BUDGET = 1800;

async function buildDietPlan(patientId, firstConsultationId) {
  section('3. Diet plan (backdated, plan-item wizard)');
  const generated = await write(
    DIETICIAN_TOKEN,
    'POST',
    `/api/dietician/patients/${patientId}/diet-plans/generate`,
    {
      firstConsultationId,
      startDate: isoDate(START_DATE),
      calorieStrategy: { name: 'Moderate Deficit', calorieBudget: CALORIE_BUDGET, calorieDeficit: 500, durationWeeks: 4 },
      macroStrategy: { name: 'Balanced', fatPercent: 25, carbsPercent: 45, proteinPercent: 30, fiberGrams: 30 },
    }
  );
  const dietPlanId = generated?.data?.dietPlanId;
  if (!dietPlanId) {
    console.log('  (dry run - no dietPlanId yet, stopping the plan-item chain here)');
    return null;
  }

  await write(
    DIETICIAN_TOKEN,
    'POST',
    `/api/dietician/patients/${patientId}/diet-plans/${dietPlanId}/generate-menu`,
    { weekNumbers: [1] }
  );

  try {
    await write(
      DIETICIAN_TOKEN,
      'POST',
      `/api/dietician/patients/${patientId}/diet-plans/${dietPlanId}/finalize-plan-item-week`
    );
  } catch (err) {
    if (err.status === 422) {
      console.log('  Finalize failed calorie tolerance - trying auto-balance once, then retrying.');
      await write(
        DIETICIAN_TOKEN,
        'POST',
        `/api/dietician/patients/${patientId}/diet-plans/${dietPlanId}/auto-balance`,
        { scope: 'plan', targetDailyCalories: CALORIE_BUDGET }
      );
      await write(
        DIETICIAN_TOKEN,
        'POST',
        `/api/dietician/patients/${patientId}/diet-plans/${dietPlanId}/finalize-plan-item-week`
      );
    } else {
      throw err;
    }
  }

  await write(
    DIETICIAN_TOKEN,
    'POST',
    `/api/dietician/patients/${patientId}/diet-plans/${dietPlanId}/activate`
  );

  return { dietPlanId };
}

async function fetchWeekPlanItemsByDayGroup(patientId, dietPlanId) {
  if (!dietPlanId) return new Map();
  const res = await read(
    DIETICIAN_TOKEN,
    `/api/dietician/patients/${patientId}/diet-plans/${dietPlanId}/weeks/1/plan-items`
  );
  const days = res?.data?.days || [];
  const byGroup = new Map();
  for (const day of days) {
    const meals = (day.meals || [])
      .filter((m) => (m.items || []).length > 0)
      .map((m) => ({
        servingTime: m.servingTime,
        recipeId: m.items[0]?.recipeVersion?.parentRecipeId || null,
        calories: m.items[0]?.calculatedNutrition?.calories ?? null,
      }));
    byGroup.set(day.dayGroup, meals);
  }
  return byGroup;
}

// ── 4. Meal logs, with Jev-driven variability ──────────────────────────────

async function decideMealCompliance(dayIndex, totalDays, meals) {
  const fallback = () => meals.map((m) => ({ ...m, compliance: 'full', servings: 1 }));
  if (meals.length === 0 || !TYPESAFE_API_KEY) return fallback();

  const questions = {};
  meals.forEach((m, i) => {
    questions[`slot_${i}`] = {
      type: 'choice',
      instructions: `Day ${dayIndex + 1} of ${totalDays} of a patient's diet plan. For the ${m.servingTime} slot (${m.calories ?? 'unknown'} kcal prescribed), how did the patient likely log it? Vary this realistically across days - not every slot every day is a perfect full log.`,
      criteria: {
        full: 'Ate the full prescribed serving',
        partial: 'Ate roughly 60-85% of the prescribed serving',
        skipped: 'Did not log this meal slot at all that day',
      },
    };
  });

  const result = await askJev(
    { dayIndex, totalDays, meals: meals.map((m) => ({ servingTime: m.servingTime, calories: m.calories })) },
    questions
  );
  if (!result?.response) return fallback();

  return meals.map((m, i) => {
    const choice = result.response[`slot_${i}`]?.choice || 'full';
    const servings = choice === 'skipped' ? 0 : choice === 'partial' ? 0.75 : 1;
    return { ...m, compliance: choice, servings };
  });
}

async function logMeals(patientId, planItemsByDayGroup, dates) {
  section('4. Meal logs (Jev-driven variability)');
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const group = dayGroupFor(date);
    const meals = planItemsByDayGroup.get(group) || [];
    const decided = await decideMealCompliance(i, dates.length, meals);
    const items = decided
      .filter((m) => m.compliance !== 'skipped' && m.recipeId)
      .map((m) => ({
        servingTime: m.servingTime,
        recipeId: m.recipeId,
        servings: m.servings,
        caloriesConsumed: m.calories != null ? Math.round(m.calories * m.servings) : undefined,
      }));
    const summary = decided.map((m) => `${m.servingTime}=${m.compliance}`).join(', ') || '(no plan items for this day-group)';
    console.log(`  ${isoDate(date)} (${group}): ${summary}`);
    if (items.length > 0) {
      await write(PATIENT_TOKEN, 'POST', '/api/patient/meal-log', { date: isoDate(date), items });
    }
  }
}

// ── 5. Exercise plan + logs, with Jev-driven exercise picks ────────────────

// Picks one exercise per day-group, sequentially, excluding groups already
// picked from each next question's candidate pool - independent per-group
// Jev choices tend to converge on the same "best overall" pick otherwise
// (nothing in a single choice question forces it to differ from another),
// so variety is enforced structurally by shrinking the pool, not by asking
// Jev to "remember" earlier picks.
async function pickExercisesPerDayGroup(catalog) {
  const byGroup = {};
  const used = new Set();

  for (const group of DAY_GROUPS) {
    const pool = catalog.filter((e) => !used.has(String(e._id)));
    const candidates = pool.length > 0 ? pool : catalog;

    let pickedId = String(candidates[0]._id);
    if (TYPESAFE_API_KEY) {
      const result = await askJev(
        candidates.map((e) => ({ id: String(e._id), name: e.name, category: e.category, difficultyLevel: e.difficultyLevel })),
        {
          pick: {
            type: 'choice',
            instructions: `Which exercise best fits a "${group}" session for a general-fitness patient on a moderate-deficit diet plan? Day-groups rotate through the week (Monday repeats Friday, Tuesday repeats Saturday, Wednesday repeats Sunday, Thursday is unique), so vary intensity/type across the week rather than always picking the same category.`,
            criteria: Object.fromEntries(candidates.map((e) => [String(e._id), `${e.name}${e.category ? ` (${e.category})` : ''}`])),
          },
        }
      );
      const choice = result?.response?.pick?.choice;
      if (candidates.some((e) => String(e._id) === choice)) pickedId = choice;
    }

    byGroup[group] = [pickedId];
    used.add(pickedId);
  }

  return byGroup;
}

// A starter set spanning categories/intensities so Jev has real variety to
// pick from per day-group, instead of one exercise repeated 4 times.
// Idempotent by name - only creates entries the catalog doesn't already have.
const STARTER_EXERCISES = [
  { name: 'Brisk Walking', category: 'Cardio', met: 3.5, difficultyLevel: 'Beginner', targetMuscleGroups: ['Legs', 'Cardiovascular'] },
  { name: 'Jumping Jacks', category: 'Cardio', met: 8.0, difficultyLevel: 'Beginner', targetMuscleGroups: ['Full Body', 'Cardiovascular'] },
  { name: 'Cycling (Moderate)', category: 'Cardio', met: 7.5, difficultyLevel: 'Intermediate', targetMuscleGroups: ['Legs', 'Cardiovascular'] },
  { name: 'Bodyweight Squats', category: 'Strength', met: 5.0, difficultyLevel: 'Beginner', targetMuscleGroups: ['Legs', 'Glutes'] },
  { name: 'Push-Ups', category: 'Strength', met: 3.8, difficultyLevel: 'Intermediate', targetMuscleGroups: ['Chest', 'Arms', 'Core'] },
  { name: 'Yoga Flow', category: 'Flexibility', met: 2.5, difficultyLevel: 'Beginner', targetMuscleGroups: ['Full Body'] },
];

async function ensureExerciseCatalog() {
  const catalogRes = await read(DIETICIAN_TOKEN, '/api/dietician/exercises?limit=100');
  const catalog = catalogRes?.data?.exercises || catalogRes?.data || [];
  const existingNames = new Set(catalog.map((e) => String(e.name).toLowerCase()));
  const missing = STARTER_EXERCISES.filter((e) => !existingNames.has(e.name.toLowerCase()));
  if (missing.length === 0) {
    console.log(`  Catalog already has ${catalog.length} exercise(s) covering the starter set - not adding more.`);
    return catalog;
  }
  console.log(`  Catalog has ${catalog.length} exercise(s); adding ${missing.length} more for variety.`);
  const created = [];
  for (const ex of missing) {
    const res = await write(DIETICIAN_TOKEN, 'POST', '/api/dietician/exercises', ex);
    if (res?.data) created.push(res.data);
  }
  return EXECUTE
    ? [...catalog, ...created]
    : [...catalog, ...missing.map((e, i) => ({ ...e, _id: `dry-run-new-${i}` }))];
}

async function buildExercisePlan(patientId) {
  section('5. Exercise plan (Jev-picked catalog exercises)');
  const catalog = await ensureExerciseCatalog();
  if (catalog.length === 0) {
    console.log('  Dietician has no exercises in their catalog - cannot build an exercise plan. Skipping.');
    return null;
  }

  const byGroup = await pickExercisesPerDayGroup(catalog);
  const dailyExercises = DAY_GROUPS.flatMap((group) =>
    byGroup[group].map((exerciseId) => ({ exerciseId, durationMinutes: 20, dayGroup: group }))
  );

  const upserted = await write(
    DIETICIAN_TOKEN,
    'POST',
    `/api/dietician/patients/${patientId}/exercise-plans`,
    { dailyExercises }
  );
  const exercisePlanId = upserted?.data?._id;
  if (!exercisePlanId) {
    console.log('  (dry run - no exercisePlanId yet, skipping activate + logging simulation)');
    return { byGroup };
  }

  await write(
    DIETICIAN_TOKEN,
    'POST',
    `/api/dietician/patients/${patientId}/exercise-plans/${exercisePlanId}/activate`
  );

  return { exercisePlanId, byGroup };
}

async function logExercises(byGroup, dates) {
  if (!byGroup) return;
  section('6. Exercise logs');
  for (const date of dates) {
    const group = dayGroupFor(date);
    const exerciseIds = byGroup[group] || [];
    if (exerciseIds.length === 0) continue;
    const exercises = exerciseIds.map((exerciseId) => ({ exerciseId, durationMinutes: 20 }));
    await write(PATIENT_TOKEN, 'POST', '/api/patient/exercise-log', { date: isoDate(date), exercises });
  }
}

// ── main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log(EXECUTE ? '=== EXECUTING patient history seed ===' : '=== DRY RUN (pass --execute to write) ===');
  console.log(`API base: ${API_BASE}`);
  console.log(`Target patient: ${TARGET_EMAIL}`);
  const dates = dateRange(START_DATE, LOG_DAYS);
  console.log(`Backfill range: ${isoDate(START_DATE)} .. ${isoDate(dates.at(-1))} (${LOG_DAYS} days)`);
  console.log(`Jev/TypeSafe: ${TYPESAFE_API_KEY ? 'enabled' : 'disabled (no TYPESAFE_API_KEY) - using fixed fallback choices'}`);

  await resolveTokens();
  const { patientId, weight, height } = await resolveIdentities();

  await ensureMembershipPlan(patientId, weight, height);
  const firstConsultationId = await ensureFirstConsultation(patientId);

  const plan = await buildDietPlan(patientId, firstConsultationId);
  const planItemsByDayGroup = await fetchWeekPlanItemsByDayGroup(patientId, plan?.dietPlanId);
  await logMeals(patientId, planItemsByDayGroup, dates);

  const exercisePlan = await buildExercisePlan(patientId);
  await logExercises(exercisePlan?.byGroup, dates);

  console.log(`\n${EXECUTE ? '=== DONE ===' : '=== DRY RUN COMPLETE - re-run with --execute to write ==='}`);
  if (EXECUTE) {
    console.log(
      `Next: run scripts/patch-exercise-plan-startdate.js inside Coolify's console to backdate ExercisePlan.startDate to ${isoDate(START_DATE)}.`
    );
  }
}

main().catch((err) => {
  console.error('\nSeed failed:', err.message);
  if (err.body) console.error('Response body:', JSON.stringify(err.body, null, 2));
  process.exit(1);
});
