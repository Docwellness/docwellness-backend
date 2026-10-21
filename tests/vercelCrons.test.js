const fs = require('fs');
const path = require('path');

const { crons } = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8')
);

// Vercel Hobby rejects the deployment unless every cron runs at most once a day,
// i.e. has a numeric minute and hour.
describe('vercel.json crons', () => {
  it('uses a numeric minute and hour on every cron', () => {
    crons.forEach(({ path: cronPath, schedule }) => {
      const [minute, hour] = schedule.split(' ');
      expect({ cronPath, minute }).toEqual({ cronPath, minute: expect.stringMatching(/^\d+$/) });
      expect({ cronPath, hour }).toEqual({ cronPath, hour: expect.stringMatching(/^\d+$/) });
    });
  });

  it('does not schedule drain-jobs (dev has no Redis, jobs run inline)', () => {
    expect(crons.filter((c) => c.path.includes('drain-jobs'))).toEqual([]);
  });

  // Not a length check: other branches (e.g. main) legitimately carry extra daily crons.
  it('keeps the known daily crons, each scheduled once', () => {
    const base = '/api/internal/cron';
    const expected = [
      `${base}/renewal-reminders`,
      `${base}/goal-nudges`,
      ...['Morning%20Drink', 'Breakfast', 'Brunch', 'Lunch', 'Evening%20Snack', 'Dinner', 'Night%20Drink']
        .map((slot) => `${base}/meal-reminder?slot=${slot}`),
      ...[1, 2, 3, 4].map((n) => `${base}/water-reminder?checkpoint=${n}`),
    ];
    const paths = crons.map((c) => c.path);

    expect(paths).toEqual(expect.arrayContaining(expected));
    expect(new Set(paths).size).toBe(paths.length);
  });
});
