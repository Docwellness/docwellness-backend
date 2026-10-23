/**
 * Plan dates for the admin patient detail (openspec admin-plan-dates-timeline).
 *
 * A pure builder: no model imports, no database, so every rule is unit tested
 * with fixtures. It puts every date that decides when a plan "ends" side by
 * side and labels each as stored (what the database holds) or shown (what the
 * apps show after the virtual pause shift). All date-only values leave as
 * 'YYYY-MM-DD' day keys; the membership end is a timestamp read on its
 * Asia/Kolkata day (istDayKey below), like the plan-end rule does.
 *
 * The pause maths is NOT copied: it comes from utils/subscriptionPause.js, so
 * this panel cannot disagree with the apps. The stored membership end already
 * includes pauses (the pause controller moves it), so it is never shifted here.
 *
 * Inputs are lean rows. `requests`, `goals` come newest first, `extensionEntries`
 * oldest first (the controller sorts them); `unionPauses` is the patient's pause
 * union across every cycle (patientPauseGuard.loadPatientPauses).
 */

const {
  normDate,
  dayDiff,
  pauseLengthDays,
  normalizePauses,
  shiftWeekRangeForPauses,
  shiftDateForPauses,
  totalShiftDays,
} = require('./subscriptionPause');

const REASON_MAX = 200;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** 'YYYY-MM-DD' of the Asia/Kolkata day containing `date`, or null when it is not a date. */
const istDayKey = (date) => {
  if (date === null || date === undefined || date === '') return null;
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
};

/** 'YYYY-MM-DD' of the UTC day of `value`, or null when it is not a date. */
const dayKey = (value) => {
  const d = normDate(value);
  return d ? d.toISOString().slice(0, 10) : null;
};

const isoOrNull = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const idOrNull = (value) => (value ? String(value) : null);

/** Stored windows of one plan as rows; malformed windows (no dates, resume <= start) are skipped. */
function buildPauseRows(pauses, today) {
  return (Array.isArray(pauses) ? pauses : [])
    .map((p) => ({
      startDate: normDate(p?.startDate),
      resumeDate: normDate(p?.resumeDate),
      createdAt: p?.createdAt,
    }))
    .filter((p) => p.startDate && p.resumeDate && p.resumeDate > p.startDate)
    .sort((a, b) => a.startDate - b.startDate)
    .map((p) => ({
      startDay: dayKey(p.startDate),
      resumeDay: dayKey(p.resumeDate),
      lengthDays: pauseLengthDays(p),
      state: p.startDate > today ? 'scheduled' : p.resumeDate > today ? 'running' : 'ended',
      recordedAt: isoOrNull(p.createdAt),
      setBy: null,
    }));
}

function buildWeekRows(weekSchedule, unionPauses) {
  return (Array.isArray(weekSchedule) ? weekSchedule : []).map((w) => {
    const start = normDate(w?.startDate);
    const end = normDate(w?.endDate);
    const shown = start && end ? shiftWeekRangeForPauses(unionPauses, start, end) : null;
    return {
      week: w?.week ?? null,
      storedStart: dayKey(start),
      storedEnd: dayKey(end),
      shownStart: shown ? dayKey(shown.startDate) : null,
      shownEnd: shown ? dayKey(shown.endDate) : null,
    };
  });
}

/** The week that ends last (by stored end), as { stored, shown }, or null when no week has an end. */
function lastWeekEndOf(weeks) {
  const dated = weeks.filter((w) => w.storedEnd && w.shownEnd);
  if (!dated.length) return null;
  const last = dated.reduce((a, b) => (b.storedEnd > a.storedEnd ? b : a));
  return { stored: last.storedEnd, shown: last.shownEnd };
}

function buildCycle(plan, unionPauses, today) {
  const weeks = buildWeekRows(plan.weekSchedule, unionPauses);
  return {
    planId: idOrNull(plan._id),
    cycleNumber: plan.cycleNumber ?? 1,
    status: plan.status ?? null,
    activationDate: dayKey(plan.activationDate),
    weeks,
    lastWeekEnd: lastWeekEndOf(weeks),
    pauses: buildPauseRows(plan.pauses, today),
  };
}

const byCycleNumber = (a, b) => a.cycleNumber - b.cycleNumber;

function buildRequest(request, index, plansOfRequest, unionPauses, today) {
  const expiresDay = istDayKey(request.subscriptionExpiresAt);
  // Only windows stored on this request's own plans were applied to its expiry.
  const pauseDaysIncluded = plansOfRequest.reduce((sum, p) => sum + totalShiftDays(p.pauses), 0);
  return {
    requestId: idOrNull(request._id),
    isLatest: index === 0,
    status: request.status ?? null,
    requestedAt: isoOrNull(request.createdAt),
    startedAt: isoOrNull(request.subscriptionStartDate),
    expiresAt: isoOrNull(request.subscriptionExpiresAt),
    expiresDay,
    pauseDaysIncluded,
    expiresBeforePausesDay: expiresDay
      ? dayKey(normDate(expiresDay).getTime() - pauseDaysIncluded * 86400000)
      : null,
    cycles: plansOfRequest.map((p) => buildCycle(p, unionPauses, today)).sort(byCycleNumber),
  };
}

function buildGoals(goals, unionPauses, plans) {
  const plansById = new Map(plans.map((p) => [String(p._id), p]));
  return (Array.isArray(goals) ? goals : []).map((g) => {
    const seed = g.dietPlanId ? plansById.get(String(g.dietPlanId)) : null;
    return {
      status: g.status ?? null,
      storedStart: dayKey(g.startDate),
      storedEnd: dayKey(g.endDate),
      shownEnd: g.endDate ? dayKey(shiftDateForPauses(unionPauses, g.endDate)) : null,
      dietPlanId: idOrNull(g.dietPlanId),
      // The plan the goal was seeded from, only when that plan was loaded.
      seededFromCycle: seed ? (seed.cycleNumber ?? 1) : null,
    };
  });
}

// Actor and reason are shown only to an admin who may view the audit log;
// `restricted` says so explicitly, so an empty reason is never read as hidden.
function buildExtensions(entries, canViewAudit) {
  const list = Array.isArray(entries) ? entries : [];
  const failedIds = new Set(
    list.filter((e) => e.outcome === 'failed' && e.requestId).map((e) => String(e.requestId))
  );
  return list
    .filter((e) => e.outcome === 'success')
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .map((e) => ({
      at: isoOrNull(e.createdAt),
      actorEmail: canViewAudit ? (e.actorEmail ?? null) : null,
      before: istDayKey(e.before?.subscriptionExpiresAt),
      after: istDayKey(e.after?.subscriptionExpiresAt),
      reason: canViewAudit ? String(e.reason ?? '').slice(0, REASON_MAX) : null,
      applied: !(e.requestId && failedIds.has(String(e.requestId))),
      restricted: !canViewAudit,
    }));
}

const gapFrom = (shownDay, membershipEndDay) =>
  shownDay && membershipEndDay ? dayDiff(shownDay, membershipEndDay) : null;

function buildSummary(latest, goals) {
  const membershipEndDay = latest?.expiresDay ?? null;

  let lastWeekEnd = null;
  const cyclesWithWeeks = (latest?.cycles ?? []).filter((c) => c.lastWeekEnd);
  if (cyclesWithWeeks.length) {
    const cycle = cyclesWithWeeks[cyclesWithWeeks.length - 1];
    lastWeekEnd = { ...cycle.lastWeekEnd, cycleNumber: cycle.cycleNumber };
  }

  const active = goals.find((g) => g.status === 'active');
  const goalEnd = active
    ? { stored: active.storedEnd, shown: active.shownEnd, status: active.status }
    : null;

  return {
    requestId: latest?.requestId ?? null,
    membershipEndDay,
    lastWeekEnd,
    goalEnd,
    gapDays: {
      lastWeekShown: gapFrom(lastWeekEnd?.shown, membershipEndDay),
      goalShown: gapFrom(goalEnd?.shown, membershipEndDay),
    },
  };
}

/**
 * @param {object} input
 * @param {object[]} input.plans DietPlan rows (request, cycleNumber, status, activationDate, weekSchedule, pauses)
 * @param {object[]} input.requests DietPlanRequest rows, newest first
 * @param {object[]} input.goals Goal rows, newest first (no title, metric or target fields are read)
 * @param {object[]} input.extensionEntries AdminAuditLog rows, outcome success or failed
 * @param {object[]} input.unionPauses the patient's pause union across all cycles
 * @param {Date} [input.now]
 * @param {boolean} [input.canViewAudit] true when the admin has audit:view; else extension actor and reason are null
 */
function buildPlanDates({
  plans = [],
  requests = [],
  goals = [],
  extensionEntries = [],
  unionPauses = [],
  now = new Date(),
  canViewAudit = false,
}) {
  const today = normDate(now);
  const union = normalizePauses(unionPauses);

  const plansByRequest = new Map();
  const unlinked = [];
  for (const plan of plans) {
    if (!plan.request) {
      unlinked.push(plan);
      continue;
    }
    const key = String(plan.request);
    if (!plansByRequest.has(key)) plansByRequest.set(key, []);
    plansByRequest.get(key).push(plan);
  }

  const requestRows = requests.map((r, i) =>
    buildRequest(r, i, plansByRequest.get(String(r._id)) ?? [], union, today)
  );
  // A plan whose request is not among the loaded requests is still listed, never dropped.
  const knownIds = new Set(requests.map((r) => String(r._id)));
  const older = [];
  for (const [key, orphans] of plansByRequest) {
    if (!knownIds.has(key)) older.push(...orphans);
  }

  const goalRows = buildGoals(goals, union, plans);

  return {
    today: dayKey(today),
    appliedPauseDays: totalShiftDays(union),
    summary: buildSummary(requestRows[0], goalRows),
    requests: requestRows,
    unlinkedCycles: unlinked.map((p) => buildCycle(p, union, today)).sort(byCycleNumber),
    // Plans of a request outside the loaded window, newest cycle first.
    olderCycles: older.map((p) => buildCycle(p, union, today)).sort((a, b) => b.cycleNumber - a.cycleNumber),
    goals: goalRows,
    extensions: buildExtensions(extensionEntries, canViewAudit),
  };
}

module.exports = { buildPlanDates, istDayKey };
