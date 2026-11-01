// Planned weight trend for the Progress charts, shared by the patient and the
// dietician tracking endpoints so the two cannot diverge.
//
// The planned line is re-based at every weekly-checkpoint weigh-in: from the
// latest checkpoint weigh-in on or before a day, straight to the goal's target
// weight on the goal's end date. Before any checkpoint weigh-in it runs from
// the goal's start weight on the patient's first plan start. Untagged and
// dietician-entered weigh-ins are measured points only; they never re-base.
// Logged weights are only read, never changed.

const { Goal, Progress } = require('../models');
const { MS_PER_DAY, localDateStr } = require('./trackingBuckets');
const { loadPatientPauses } = require('./patientPauseGuard');
const { shiftDateForPauses } = require('./subscriptionPause');
const { loadCheckpointWeeks, displayWeekForLegacyEntry } = require('./checkpointWeeks');

// ~12 weeks - only used when the patient has no active goal yet.
const DEFAULT_SPAN_DAYS = 84;

const round1 = (n) => Math.round(n * 10) / 10;

function dayMs(date) {
  const d = new Date(date);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * The day a weigh-in is plotted on. One tagged to a weekly checkpoint belongs
 * to that checkpoint's date, not the day it was typed in (Week 3's weight
 * entered on the 15th plots on the 11th) - unless it was entered before that
 * date, then the real day wins.
 */
function plottedDayMs(weighIn) {
  const real = dayMs(weighIn.date);
  if (weighIn.displayWeek && weighIn.checkpointDate) {
    const checkpoint = dayMs(weighIn.checkpointDate);
    if (checkpoint < real) return checkpoint;
  }
  return real;
}

/**
 * @param {object} p
 * @param {Array<{start:Date,end:Date,label:string}>} p.buckets
 * @param {Date} p.today UTC midnight of today
 * @param {Date} p.now
 * @param {number} p.currentWeight used when the planned value is 0
 * @param {number} p.goalStartWeight
 * @param {number} p.goalTargetWeight
 * @param {Date} p.goalEnd goal end date after pause shift
 * @param {Date} p.historyStart first plan start, where the goal start weight applies
 * @param {Array<{date:Date,weight:number,displayWeek:number|null,checkpointDate?:Date}>} p.weighIns
 * @returns {Array<{label,date,weight,measuredWeight,measuredDate}>}
 */
function buildRebasedWeightTrend({
  buckets,
  today,
  now,
  currentWeight,
  goalStartWeight,
  goalTargetWeight,
  goalEnd,
  historyStart,
  weighIns,
}) {
  const sorted = [...weighIns].sort((a, b) => new Date(a.date) - new Date(b.date));

  // One measured value per plotted day; a same-day resubmission keeps the
  // latest write. Only checkpoint-tagged weigh-ins become anchors.
  const measuredByDay = new Map();
  const anchorByDay = new Map();
  for (const w of sorted) {
    const day = plottedDayMs(w);
    measuredByDay.set(day, w.weight);
    if (w.displayWeek) anchorByDay.set(day, w.weight);
  }

  const anchors = [{ t: dayMs(historyStart), w: goalStartWeight }];
  for (const [t, w] of [...anchorByDay].sort((a, b) => a[0] - b[0])) anchors.push({ t, w });

  const goalEndMs = dayMs(goalEnd);
  const plannedOn = (day) => {
    const d = dayMs(day);
    let anchor = anchors[0];
    for (const a of anchors) if (a.t <= d) anchor = a;
    if (goalEndMs <= anchor.t) return goalTargetWeight;
    const fraction = Math.min(1, Math.max(0, (d - anchor.t) / (goalEndMs - anchor.t)));
    return anchor.w + (goalTargetWeight - anchor.w) * fraction;
  };

  return buckets.map((bucket) => {
    // Compare calendar days against `today`, not `now` - a bucket that
    // starts today must not fall into the future branch.
    if (bucket.start > today) {
      return { label: bucket.label, date: '', weight: 0, measuredWeight: null, measuredDate: null };
    }
    const effectiveEnd = bucket.end > now ? now : bucket.end;
    const planned = round1(plannedOn(effectiveEnd));

    const bucketStartMs = dayMs(bucket.start);
    const bucketEndMs = dayMs(effectiveEnd);
    let measured = null;
    for (const [day, weight] of measuredByDay) {
      if (day >= bucketStartMs && day <= bucketEndMs && (!measured || day > measured.day)) {
        measured = { day, weight };
      }
    }

    return {
      label: bucket.label,
      date: localDateStr(effectiveEnd),
      weight: planned > 0 ? planned : round1(currentWeight),
      measuredWeight: measured ? round1(measured.weight) : null,
      // Day the weigh-in is plotted on (the bucket's own `date` is just its
      // end), so the chart can draw the real point at its real date.
      measuredDate: measured ? localDateStr(new Date(measured.day)) : null,
    };
  });
}

/**
 * Everything buildRebasedWeightTrend needs for one patient, so the patient
 * and dietician endpoints load it the same way.
 *
 * @param {string} patientId
 * @param {object} o
 * @param {Date} o.historyStart first plan start (chart floor, goal start weight day)
 * @param {Date} o.rangeStart fallback lower bound when there is no history start
 * @param {Date} o.rangeEnd
 * @param {number} o.currentWeight
 * @param {number} o.profileTargetWeight target from the health profile, 0 if none
 */
async function loadWeightTrendInputs(
  patientId,
  { historyStart, rangeStart, rangeEnd, currentWeight, profileTargetWeight }
) {
  const goal = await Goal.findOne({ patientId, status: 'active' })
    .select('_id startValue targetValue startDate endDate')
    .lean();
  const goalStartWeight = goal?.startValue ?? currentWeight;
  const goalTargetWeight = goal?.targetValue ?? (profileTargetWeight || goalStartWeight);

  const floor = historyStart || rangeStart;
  let goalEnd;
  if (goal?.endDate) {
    const pauses = await loadPatientPauses(patientId);
    goalEnd = shiftDateForPauses(pauses, goal.endDate);
  } else {
    goalEnd = new Date(dayMs(floor) + DEFAULT_SPAN_DAYS * MS_PER_DAY);
  }

  const { cycles, checkpoints } = await loadCheckpointWeeks(patientId, goal?._id);
  const checkpointDateByWeek = new Map(checkpoints.map((c) => [c.displayWeek, new Date(c.date)]));

  const logs = await Progress.find({
    patientId,
    weight: { $exists: true, $ne: null },
    date: { $gte: floor, $lte: rangeEnd },
  })
    .sort({ date: 1 })
    .select('date weight week weekBasis source')
    .lean();
  const weighIns = logs.map((l) => {
    const displayWeek = displayWeekForLegacyEntry(l, cycles, checkpoints);
    return {
      date: l.date,
      weight: l.weight,
      displayWeek,
      checkpointDate: displayWeek ? checkpointDateByWeek.get(displayWeek) || null : null,
    };
  });

  return { goalStartWeight, goalTargetWeight, goalEnd, weighIns };
}

module.exports = { buildRebasedWeightTrend, loadWeightTrendInputs };
