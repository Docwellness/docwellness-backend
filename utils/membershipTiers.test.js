/**
 * membershipTiers Tests
 * Plain assertion script (no framework), matching the project's existing
 * dietPlanOptions.test.js / weekSchedule.test.js convention.
 * Run with: node utils/membershipTiers.test.js
 */

const assert = require('assert');
const { getMembershipTier, validateRegenerateRequest } = require('./membershipTiers');
const { buildWeekSchedule } = require('./weekSchedule');

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, error: error.message });
  }
}

test('getMembershipTier matches case-insensitively by substring', () => {
  assert.strictEqual(getMembershipTier('Golden Membership'), 'golden');
  assert.strictEqual(getMembershipTier('platinum'), 'platinum');
  assert.strictEqual(getMembershipTier('SILVER MEMBERSHIP'), 'silver');
  assert.strictEqual(getMembershipTier('Something Else'), null);
  assert.strictEqual(getMembershipTier(null), null);
});

test('silver never allows regeneration', () => {
  const result = validateRegenerateRequest({ tier: 'silver', weekNumbers: [2] });
  assert.strictEqual(result.ok, false);
});

test('week 1 is always allowed regardless of date/finalization', () => {
  const result = validateRegenerateRequest({ tier: 'golden', weekNumbers: [1], finalizedWeekNumbers: [] });
  assert.strictEqual(result.ok, true);
});

// Anchor far enough in the past that "now" (real time) is always well past
// week 2's end + the 2-day window - simulates "week 2 ended weeks ago".
const pastSchedule = buildWeekSchedule('2020-01-01');

test('golden weeks 3-4: rejected if week 2 not finalized, even with window open', () => {
  const result = validateRegenerateRequest({
    tier: 'golden',
    weekNumbers: [3, 4],
    finalizedWeekNumbers: [],
    currentWeekSchedule: pastSchedule[1],
  });
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /finalized/i);
});

test('golden weeks 3-4: rejected if window not open yet, even if week 2 finalized', () => {
  const now = new Date('2026-07-22T00:00:00.000Z');
  const schedule = buildWeekSchedule(now); // week 2 ends 13 days from "now"
  const result = validateRegenerateRequest({
    tier: 'golden',
    weekNumbers: [3, 4],
    finalizedWeekNumbers: [2],
    currentWeekSchedule: schedule[1],
    now,
  });
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /last 2 days/i);
});

test('golden weeks 3-4: allowed once week 2 finalized AND within last 2 days of week 2', () => {
  const schedule = buildWeekSchedule('2026-07-22');
  const week2End = schedule[1].endDate; // 2026-08-04
  const nowInWindow = new Date(week2End.getTime() - 1 * 24 * 60 * 60 * 1000); // 1 day before end
  const result = validateRegenerateRequest({
    tier: 'golden',
    weekNumbers: [3, 4],
    finalizedWeekNumbers: [2],
    currentWeekSchedule: schedule[1],
    now: nowInWindow,
  });
  assert.strictEqual(result.ok, true);
});

test('golden weeks 3-4: allowed exactly at the window boundary (2 days before end)', () => {
  const schedule = buildWeekSchedule('2026-07-22');
  const week2End = schedule[1].endDate;
  const atBoundary = new Date(week2End.getTime() - 2 * 24 * 60 * 60 * 1000);
  const result = validateRegenerateRequest({
    tier: 'golden',
    weekNumbers: [3, 4],
    finalizedWeekNumbers: [2],
    currentWeekSchedule: schedule[1],
    now: atBoundary,
  });
  assert.strictEqual(result.ok, true);
});

test('platinum week 2: rejected if week 1 not finalized', () => {
  const result = validateRegenerateRequest({
    tier: 'platinum',
    weekNumbers: [2],
    finalizedWeekNumbers: [],
    currentWeekSchedule: pastSchedule[0],
  });
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /finalized/i);
});

test('platinum week 2: rejected if window not open yet', () => {
  const now = new Date('2026-07-22T00:00:00.000Z');
  const schedule = buildWeekSchedule(now);
  const result = validateRegenerateRequest({
    tier: 'platinum',
    weekNumbers: [2],
    finalizedWeekNumbers: [1],
    currentWeekSchedule: schedule[0],
    now,
  });
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /last 2 days/i);
});

test('platinum week 2: allowed once week 1 finalized AND within last 2 days of week 1', () => {
  const schedule = buildWeekSchedule('2026-07-22');
  const week1End = schedule[0].endDate;
  const nowInWindow = new Date(week1End.getTime() - 1 * 24 * 60 * 60 * 1000);
  const result = validateRegenerateRequest({
    tier: 'platinum',
    weekNumbers: [2],
    finalizedWeekNumbers: [1],
    currentWeekSchedule: schedule[0],
    now: nowInWindow,
  });
  assert.strictEqual(result.ok, true);
});

test('missing currentWeekSchedule does not crash - treated as window open (backward-compat)', () => {
  const result = validateRegenerateRequest({
    tier: 'platinum',
    weekNumbers: [2],
    finalizedWeekNumbers: [1],
    currentWeekSchedule: null,
    now: new Date(),
  });
  assert.strictEqual(result.ok, true);
});

const failed = results.filter((r) => !r.passed);
for (const r of results) {
  console.log(`${r.passed ? 'PASS' : 'FAIL'} - ${r.name}${r.error ? `: ${r.error}` : ''}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
