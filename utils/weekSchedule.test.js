/**
 * weekSchedule Tests
 * Plain assertion script (no framework), matching the project's existing
 * dietPlanOptions.test.js / ingredientQuantityValidator.test.js convention.
 * Run with: node utils/weekSchedule.test.js
 */

const assert = require('assert');
const { buildWeekSchedule, buildSequentialWeekEntries, mergeWeekSchedule } = require('./weekSchedule');

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, error: error.message });
  }
}

test('produces 4 weeks, each starting 7 days after the previous', () => {
  const anchor = new Date('2026-07-22T00:00:00.000Z');
  const schedule = buildWeekSchedule(anchor);
  assert.strictEqual(schedule.length, 4);
  assert.strictEqual(schedule[0].week, 1);
  assert.strictEqual(schedule[0].startDate.toISOString(), '2026-07-22T00:00:00.000Z');
  assert.strictEqual(schedule[1].startDate.toISOString(), '2026-07-29T00:00:00.000Z');
  assert.strictEqual(schedule[2].startDate.toISOString(), '2026-08-05T00:00:00.000Z');
  assert.strictEqual(schedule[3].startDate.toISOString(), '2026-08-12T00:00:00.000Z');
});

test('each week spans exactly 7 days (endDate is 6 days after startDate)', () => {
  const schedule = buildWeekSchedule(new Date('2026-07-22T00:00:00.000Z'));
  for (const entry of schedule) {
    const diffDays = (entry.endDate - entry.startDate) / (24 * 60 * 60 * 1000);
    assert.strictEqual(diffDays, 6);
  }
});

test('weeks are contiguous - week N end is exactly 1 day before week N+1 start', () => {
  const schedule = buildWeekSchedule(new Date('2026-07-22T00:00:00.000Z'));
  for (let i = 0; i < 3; i++) {
    const gapDays = (schedule[i + 1].startDate - schedule[i].endDate) / (24 * 60 * 60 * 1000);
    assert.strictEqual(gapDays, 1);
  }
});

test('accepts a string date as anchor', () => {
  const schedule = buildWeekSchedule('2026-07-22');
  assert.strictEqual(schedule[0].startDate.toISOString().slice(0, 10), '2026-07-22');
});

test('buildSequentialWeekEntries: single week just spans 7 days from the chosen date', () => {
  const entries = buildSequentialWeekEntries([2], new Date('2026-09-01T00:00:00.000Z'));
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].week, 2);
  assert.strictEqual(entries[0].startDate.toISOString(), '2026-09-01T00:00:00.000Z');
  assert.strictEqual(entries[0].endDate.toISOString(), '2026-09-07T00:00:00.000Z');
});

test('buildSequentialWeekEntries: a pair (Golden weeks 3-4) is back-to-back from the chosen date', () => {
  const entries = buildSequentialWeekEntries([3, 4], new Date('2026-09-01T00:00:00.000Z'));
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].week, 3);
  assert.strictEqual(entries[0].startDate.toISOString(), '2026-09-01T00:00:00.000Z');
  assert.strictEqual(entries[1].week, 4);
  assert.strictEqual(entries[1].startDate.toISOString(), '2026-09-08T00:00:00.000Z');
});

test('mergeWeekSchedule: replaces only the matching week(s), leaves others untouched', () => {
  const original = buildWeekSchedule('2026-07-22');
  const updated = buildSequentialWeekEntries([2], new Date('2026-12-25T00:00:00.000Z'));
  const merged = mergeWeekSchedule(original, updated);
  assert.strictEqual(merged.length, 4);
  assert.strictEqual(merged.find((e) => e.week === 2).startDate.toISOString(), '2026-12-25T00:00:00.000Z');
  // weeks 1, 3, 4 unchanged
  assert.strictEqual(merged.find((e) => e.week === 1).startDate.toISOString(), original[0].startDate.toISOString());
  assert.strictEqual(merged.find((e) => e.week === 3).startDate.toISOString(), original[2].startDate.toISOString());
  assert.strictEqual(merged.find((e) => e.week === 4).startDate.toISOString(), original[3].startDate.toISOString());
});

test('mergeWeekSchedule: result is sorted by week number even if existing entries were out of order', () => {
  const outOfOrder = [
    { week: 3, startDate: new Date('2026-01-15'), endDate: new Date('2026-01-21') },
    { week: 1, startDate: new Date('2026-01-01'), endDate: new Date('2026-01-07') },
  ];
  const merged = mergeWeekSchedule(outOfOrder, [{ week: 2, startDate: new Date('2026-01-08'), endDate: new Date('2026-01-14') }]);
  assert.deepStrictEqual(merged.map((e) => e.week), [1, 2, 3]);
});

const failed = results.filter((r) => !r.passed);
for (const r of results) {
  console.log(`${r.passed ? 'PASS' : 'FAIL'} - ${r.name}${r.error ? `: ${r.error}` : ''}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
