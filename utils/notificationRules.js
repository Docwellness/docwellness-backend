/**
 * Catalogue of every automated notification the platform sends, plus the
 * helpers the cron sweeps use to read an admin's overrides.
 *
 * Only `editable` rules (the cron sweeps) read their wording and on/off state
 * from the NotificationRule collection. The rest are listed so the admin can
 * see everything that reaches a user, but their text is built from live data
 * (a chat message, a patient's name) at the call site and stays in code.
 *
 * Cron times are UTC, copied from vercel.json. They are shown in the admin
 * panel read-only: changing when a sweep runs is an infrastructure change.
 */
const NotificationRule = require('../models/NotificationRule');

const TITLE_MAX = 65;
const MESSAGE_MAX = 240;

const MEAL_SLOTS = [
  ['Morning Drink', '0 1 * * *'],
  ['Breakfast', '0 3 * * *'],
  ['Brunch', '0 5 * * *'],
  ['Lunch', '0 7 * * *'],
  ['Evening Snack', '0 11 * * *'],
  ['Dinner', '0 14 * * *'],
  ['Night Drink', '30 15 * * *'],
];
const WATER_TIMES = ['30 4 * * *', '30 7 * * *', '30 10 * * *', '30 13 * * *'];

/** "30 4 * * *" (UTC) -> "10:00 AM" (IST). Only handles the daily "m h * * *" form used above. */
function istTime(cron) {
  const [m, h] = cron.split(' ').map(Number);
  const total = (h * 60 + m + 330) % (24 * 60);
  const hh = Math.floor(total / 60);
  const mm = String(total % 60).padStart(2, '0');
  return `${((hh + 11) % 12) + 1}:${mm} ${hh < 12 ? 'AM' : 'PM'}`;
}

const RULES = [
  {
    key: 'meal_reminder',
    name: 'Meal reminder',
    kind: 'scheduled',
    audience: 'Patients',
    editable: true,
    trigger:
      'Before each meal slot on the patient\'s plan today, if they have not logged it yet. Sent once per slot per day.',
    schedule: MEAL_SLOTS.map(([slot, cron]) => `${slot} ${istTime(cron)}`),
    placeholders: ['slot'],
    sample: { slot: 'Lunch' },
    defaults: {
      title: 'Time for {slot}',
      message: "Don't forget to log your {slot} once you've had it.",
    },
    match: { type: 'meal_reminder' },
  },
  {
    key: 'water_reminder',
    name: 'Water reminder',
    kind: 'scheduled',
    audience: 'Patients',
    editable: true,
    trigger: "Four times a day, to patients with an active plan who are still short of today's water goal.",
    schedule: WATER_TIMES.map(istTime),
    placeholders: ['remaining'],
    sample: { remaining: '1.2' },
    defaults: {
      title: 'Stay hydrated',
      message: "You've got {remaining}L left to reach today's water goal.",
    },
    match: { type: 'water_reminder' },
  },
  {
    key: 'renewal_reminder',
    name: 'Membership expiring',
    kind: 'scheduled',
    audience: 'Patients',
    editable: true,
    trigger: 'Daily, to patients whose subscription ends within 3 days. Sent once per subscription cycle.',
    schedule: [istTime('0 3 * * *')],
    placeholders: ['date'],
    sample: { date: '20 Oct 2026' },
    defaults: {
      title: 'Your membership is expiring soon',
      message: 'Your subscription expires on {date}. Renew now to keep your diet plan active.',
    },
    match: { type: 'membership_renewal', title: 'Your membership is expiring soon' },
  },
  {
    key: 'goal_nudge',
    name: 'Missed goal nudge',
    kind: 'scheduled',
    audience: 'Patients',
    editable: true,
    trigger: 'Daily, to patients whose goal end date has passed without reaching the target. Sent once per goal.',
    schedule: [istTime('30 3 * * *')],
    placeholders: ['goal'],
    sample: { goal: 'Lose 5 kg' },
    defaults: {
      title: "Let's get back on track",
      message:
        'You\'re close to reaching "{goal}" - don\'t stop now. Continue your diet journey and rebook your subscription to keep going.',
      pushBody: 'Continue your diet journey and rebook your subscription to reach "{goal}".',
    },
    match: { type: 'milestone', title: "Let's get back on track" },
  },

  {
    key: 'request_plan_nudge',
    name: 'Request your diet plan',
    kind: 'scheduled',
    audience: 'Patients',
    editable: true,
    // Several wordings, used in turn: each person is sent the next one after the last they received.
    rotating: true,
    trigger:
      'Daily check. Goes to patients who signed up at least a day ago, never subscribed and have not requested a diet plan. Each person gets one every 2 days at first, then weekly, with the wording changing every time. Stops for a person once they request a plan.',
    schedule: [istTime('30 12 * * *')],
    placeholders: ['name', 'goal', 'days'],
    sample: { name: 'Asha', goal: 'lose weight', days: '3' },
    defaults: {
      title: 'Your diet plan is one tap away',
      message: 'A plan to help you {goal} is ready when you are. Request your diet plan and take the first step today.',
      variants: [
        { title: '{name}, your plan is one tap away', message: 'A diet plan built to help you {goal} is ready when you are. Request it and take the first step today.' },
        { title: 'Ready to {goal}?', message: "{name}, you don't have to figure it out alone. Request your personalised diet plan and a real dietician will build it around you." },
        { title: 'Small step, big change', message: 'Requesting your diet plan takes about a minute and costs nothing. Your dietician takes it from there.' },
        { title: 'Every goal starts with a first step', message: "Yours is requesting your diet plan, {name}. It's quick, and it could be the start of something good." },
        { title: 'Meals made for you, {name}', message: 'No more guessing what to eat. Get a plan built around your tastes, your schedule and your wish to {goal}.' },
        { title: "It's been {days} days since you joined", message: 'Today is a great day to turn intent into action. Request your diet plan and let your dietician get started.' },
        { title: 'Hungry for results?', message: 'Your dietician is ready to design a plan to help you {goal}. All you need to do is ask for it.' },
        { title: 'Still thinking it over, {name}?', message: "That's okay. When you're ready, requesting your diet plan takes a minute and costs nothing." },
        { title: 'Your goal deserves a plan', message: '{name}, you want to {goal}. A plan from a real dietician is the next step. Request yours now.' },
        { title: 'Eat well without the guesswork', message: 'Personalised meals, a dietician in your corner and a plan that fits your life. Request your diet plan today.' },
      ],
    },
    match: { type: 'diet_plan_nudge' },
  },

  // Sent when something happens, not on a clock. Read-only here.
  ev('diet_plan_ready', 'Diet plan ready', 'Patients', 'A dietician activates the patient\'s diet plan.', {
    title: 'Your diet plan is ready',
    message: "Your dietician has activated your diet plan - tap to see this week's meals.",
  }, { type: 'diet_plan' }),
  ev('payment_requested', 'Payment requested', 'Patients', 'A dietician requests payment for a diet plan.', {
    title: 'Payment requested for your diet plan',
    message:
      'Your dietician has requested payment for your diet plan. Tap to review the amount and share your payment details.',
  }, { type: 'payment', title: 'Payment requested for your diet plan' }),
  ev('payment_confirmed', 'Payment confirmed', 'Patients', 'An admin confirms a manual payment proof.', {
    title: 'Payment confirmed',
    message: 'Your payment was received and your membership is active.',
  }, { type: 'payment', title: 'Payment confirmed' }),
  ev('payment_rejected', 'Payment not accepted', 'Patients', 'An admin rejects a manual payment proof. The message is the admin\'s note.', {
    title: 'Payment not accepted',
    message: "The admin's reason for rejecting the proof.",
  }, { type: 'payment', title: 'Payment not accepted' }),
  ev('consultation_review', 'First consultation to review', 'Patients', 'A dietician saves a first consultation for the patient to review and consent to.', {
    title: 'Review your first consultation',
    message: 'Your dietician has completed your first consultation. Please review it and provide your consent to continue.',
  }, { type: 'consultation' }),
  ev('quote', 'New quote', 'Patients', 'A dietician publishes a quote.', {
    title: 'New quote from your dietician',
    message: 'The text of the quote.',
  }, { type: 'quote' }),
  ev('subscription_pause', 'Subscription paused or resumed', 'Patients', 'A dietician pauses or resumes a patient\'s subscription.', {
    title: 'Set by the pause or resume action',
    message: 'Describes the pause dates.',
  }, { type: 'subscription_pause' }),
  ev('dietician_message', 'Message from dietician', 'Patients', 'A dietician sends a nudge from the patient\'s timeline.', {
    title: 'Message from your dietician',
    message: 'The text the dietician wrote.',
  }, { type: 'milestone', title: 'Message from your dietician' }),
  ev('chat_message', 'New chat message', 'Patients and dieticians', 'Someone sends a chat message while the other side is not reading it.', {
    title: 'New message from {sender}',
    message: 'The first 100 characters of the message.',
  }, { type: 'chat' }),
  ev('meal_logged', 'Patient logged a meal', 'Dieticians', 'A patient logs a meal.', {
    title: '{patient} logged a meal',
    message: 'What they ate and the calories.',
  }, { type: 'progress' }),
  ev('renewal_requested', 'Patient asked to renew', 'Dieticians', 'A patient requests a plan renewal.', {
    title: '{patient} requested a plan renewal',
    message: "Build their next diet & exercise plan when you're ready.",
  }, { type: 'membership_renewal', title: /requested a plan renewal$/ }),
];

function ev(key, name, audience, trigger, defaults, match) {
  return { key, name, kind: 'event', audience, editable: false, trigger, schedule: [], placeholders: [], sample: {}, defaults, match };
}

/**
 * Who a notification reaches, by subscription state - the same three groups
 * the Users tab filters on (status.subscriptionExpiresAt). A rule with no
 * segments is addressed to dieticians, not patients.
 */
const SEGMENTS = {
  signed_up: { label: 'Signed up', description: 'Registered but never subscribed' },
  subscribed: { label: 'Subscribed members', description: 'Subscription is running' },
  lapsed: { label: 'Plan completed, not renewed', description: 'Subscription has ended and no new plan has started' },
};

// Derived from each sweep's / call site's own recipient query, not from its name:
//  - meal and water sweeps read DietPlan status 'Active', and plans are marked Completed when they end.
//  - renewal sweep needs hasActivePlan and an expiry within 3 days.
//  - goal nudge looks only at goals past their end date; it does not check subscription state, so a
//    member who is still subscribed can get it too.
//  - payment / consultation messages go to anyone with a request open, which is a first plan or a renewal.
//  - quotes, dietician messages and chat go to any patient with (or, for the default dietician, without) a dietician.
const RULE_SEGMENTS = {
  request_plan_nudge: ['signed_up'],
  meal_reminder: ['subscribed'],
  water_reminder: ['subscribed'],
  renewal_reminder: ['subscribed'],
  goal_nudge: ['lapsed', 'subscribed'],
  diet_plan_ready: ['subscribed'],
  payment_requested: ['signed_up', 'lapsed'],
  payment_confirmed: ['signed_up', 'lapsed'],
  payment_rejected: ['signed_up', 'lapsed'],
  consultation_review: ['signed_up'],
  quote: ['signed_up', 'subscribed', 'lapsed'],
  subscription_pause: ['subscribed'],
  dietician_message: ['signed_up', 'subscribed', 'lapsed'],
  chat_message: ['signed_up', 'subscribed', 'lapsed'],
};
for (const rule of RULES) rule.segments = RULE_SEGMENTS[rule.key] || [];

const BY_KEY = new Map(RULES.map((r) => [r.key, r]));
const getRuleDef = (key) => BY_KEY.get(key) || null;

/** Replaces {name} tokens. A token with no value is left visible so a typo is obvious, never silently dropped. */
function render(template, vars = {}) {
  return String(template).replace(/\{(\w+)\}/g, (whole, name) =>
    vars[name] === undefined || vars[name] === null ? whole : String(vars[name])
  );
}

/**
 * What a sweep should send for `key`: the admin's override if there is one,
 * else the shipped default. If the lookup itself fails the defaults are used
 * and the rule stays on, so a database hiccup never silences reminders.
 */
async function loadRule(key) {
  const def = getRuleDef(key);
  if (!def) throw new Error(`unknown notification rule "${key}"`);
  let row = null;
  try {
    row = await NotificationRule.findOne({ key }).lean();
  } catch (err) {
    console.error(`[notificationRules] could not load "${key}", using defaults:`, err.message);
  }
  const variants = def.defaults.variants
    ? row?.variants?.length
      ? row.variants.map((v) => ({ title: v.title, message: v.message }))
      : def.defaults.variants
    : undefined;
  const title = variants ? variants[0].title : row?.title || def.defaults.title;
  const message = variants ? variants[0].message : row?.message || def.defaults.message;
  return {
    key,
    enabled: row ? row.enabled !== false : true,
    variants,
    title,
    message,
    // The push text follows the in-app text unless the rule ships a separate one.
    pushBody: row?.pushBody || (row?.message ? row.message : def.defaults.pushBody) || message,
  };
}

/** Returns an error string, or null when the edit is acceptable. */
function validateEdit(def, { title, message, pushBody }) {
  const allowed = new Set(def.placeholders);
  const check = (label, text, max) => {
    if (text === undefined) return null;
    const value = String(text).trim();
    if (!value) return `${label} cannot be empty`;
    if (value.length > max) return `${label} must be ${max} characters or fewer`;
    for (const [, name] of value.matchAll(/\{(\w+)\}/g)) {
      if (!allowed.has(name)) {
        const list = def.placeholders.length ? def.placeholders.map((p) => `{${p}}`).join(', ') : 'none';
        return `${label} uses {${name}}, which this notification does not support (available: ${list})`;
      }
    }
    return null;
  };
  return check('Title', title, TITLE_MAX) || check('Message', message, MESSAGE_MAX) || check('Push text', pushBody, MESSAGE_MAX);
}

const VARIANTS_MAX = 20;

/** Validates the wording list of a rotating rule. Returns an error string, or null. */
function validateVariants(def, variants) {
  if (!Array.isArray(variants) || variants.length === 0) return 'Add at least one wording';
  if (variants.length > VARIANTS_MAX) return `Use ${VARIANTS_MAX} wordings or fewer`;
  for (const [i, v] of variants.entries()) {
    const err = validateEdit(def, { title: v?.title ?? '', message: v?.message ?? '' });
    if (err) return `Wording ${i + 1}: ${err}`;
  }
  return null;
}

module.exports = { RULES, SEGMENTS, validateVariants, VARIANTS_MAX, getRuleDef, loadRule, render, validateEdit, TITLE_MAX, MESSAGE_MAX };
