/**
 * "Week Tweak" panel: a single [0.75x|1.0x|1.25x]-style multiplier per
 * servingTime, applied to every unlocked item in that slot for one
 * currently-open week (models/DietPlan.js's `days[]`/`weekTweaks`).
 *
 * dietPlan.weekTweaks stores the CURRENTLY ACTIVE multiplier per slot
 * (default 1.0) - not a delta to apply on top of whatever's already there.
 * Setting Lunch to 1.25x twice in a row must be idempotent (still 1.25x
 * total, not 1.5625x), so applyWeekTweak first undoes the slot's old
 * multiplier before applying the new one.
 */

function getWeekTweak(dietPlan, servingTime) {
  const tweaks = dietPlan.weekTweaks;
  const value = typeof tweaks?.get === 'function' ? tweaks.get(servingTime) : tweaks?.[servingTime];
  return typeof value === 'number' && value > 0 ? value : 1;
}

function setWeekTweak(dietPlan, servingTime, multiplier) {
  if (!dietPlan.weekTweaks) dietPlan.weekTweaks = new Map();
  if (typeof dietPlan.weekTweaks.set === 'function') {
    dietPlan.weekTweaks.set(servingTime, multiplier);
  } else {
    dietPlan.weekTweaks[servingTime] = multiplier;
  }
  dietPlan.markModified('weekTweaks');
}

/**
 * Mutates dietPlan.days in place (caller saves) and returns the list of
 * items actually changed, so the API layer can recompute/report affected
 * nutrition without re-walking the whole plan.
 */
function applyWeekTweak({ dietPlan, week, servingTime, multiplier }) {
  if (!(multiplier > 0)) throw new Error('multiplier must be a positive number');

  const oldMultiplier = getWeekTweak(dietPlan, servingTime);
  const factor = multiplier / oldMultiplier;
  const changedItems = [];

  for (const day of dietPlan.days || []) {
    if (day.week !== week) continue;
    for (const meal of day.meals || []) {
      if (meal.servingTime !== servingTime) continue;
      for (const item of meal.items || []) {
        if (item.locked) continue;
        item.servingMultiplier = (item.servingMultiplier ?? 1) * factor;
        changedItems.push({ dayGroup: day.dayGroup, servingTime, item });
      }
    }
  }

  setWeekTweak(dietPlan, servingTime, multiplier);
  if (changedItems.length > 0) dietPlan.markModified('days');

  return changedItems;
}

module.exports = { getWeekTweak, setWeekTweak, applyWeekTweak };
