/**
 * weekSchedule Tests
 * Plain assertion script (no framework), matching the project's existing
 * dietPlanOptions.test.js / ingredientQuantityValidator.test.js convention.
 * Run with: node utils/weekSchedule.test.js
 */

const assert = require('assert');
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

const failed = results.filter((r) => !r.passed);
for (const r of results) {
  console.log(`${r.passed ? 'PASS' : 'FAIL'} - ${r.name}${r.error ? `: ${r.error}` : ''}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
