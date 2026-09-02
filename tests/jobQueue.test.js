/**
 * Async job queue - cross-app performance optimization, Phase 3
 * (tasks 3.1 / 3.2 / 3.5). Covers utils/jobQueue directly with an
 * in-memory Redis stand-in and a mocked handler map.
 */

// --- in-memory Redis: lists + sorted sets, just what jobQueue uses ---
const lists = new Map(); // key -> array
const zsets = new Map(); // key -> Map<member, score>
const getList = (k) => {
  if (!lists.has(k)) lists.set(k, []);
  return lists.get(k);
};
const getZ = (k) => {
  if (!zsets.has(k)) zsets.set(k, new Map());
  return zsets.get(k);
};
const mockRedis = {
  async rpush(k, v) {
    return getList(k).push(v);
  },
  async lpop(k) {
    const a = getList(k);
    return a.length ? a.shift() : null;
  },
  async llen(k) {
    return getList(k).length;
  },
  async ltrim(k, start, end) {
    const a = getList(k);
    const norm = (i) => (i < 0 ? a.length + i : i);
    lists.set(k, a.slice(norm(start), norm(end) + 1));
    return 'OK';
  },
  async zadd(k, score, member) {
    getZ(k).set(member, Number(score));
    return 1;
  },
  async zrem(k, member) {
    return getZ(k).delete(member) ? 1 : 0;
  },
  async zcard(k) {
    return getZ(k).size;
  },
  async zrangebyscore(k, min, max, _limit, offset, count) {
    const lo = min === '-inf' ? -Infinity : Number(min);
    const hi = max === '+inf' ? Infinity : Number(max);
    const rows = [...getZ(k).entries()]
      .filter(([, s]) => s >= lo && s <= hi)
      .sort((a, b) => a[1] - b[1])
      .map(([m]) => m);
    return typeof count === 'number' ? rows.slice(offset, offset + count) : rows;
  },
};
jest.mock('../utils/redisClient', () => ({ client: mockRedis, isEnabled: true }));

const mockRunJob = jest.fn();
jest.mock('../utils/jobHandlers', () => ({ runJob: (...a) => mockRunJob(...a) }));

const mockCapture = jest.fn();
jest.mock('@sentry/node', () => ({ captureException: (...a) => mockCapture(...a) }));

const jobQueue = require('../utils/jobQueue');
const { PENDING_KEY, DELAYED_KEY, FAILED_KEY } = jobQueue._keys;

beforeEach(() => {
  lists.clear();
  zsets.clear();
  mockRunJob.mockReset();
  mockCapture.mockReset();
});

describe('enqueue', () => {
  test('pushes a well-formed job onto the pending list (no inline run when Redis is on)', async () => {
    const res = await jobQueue.enqueue('email', { to: 'a@b.c' });
    expect(res.id).toBeDefined();
    expect(mockRunJob).not.toHaveBeenCalled();
    const raw = getList(PENDING_KEY);
    expect(raw).toHaveLength(1);
    const job = JSON.parse(raw[0]);
    expect(job).toMatchObject({ type: 'email', payload: { to: 'a@b.c' }, attempts: 0 });
    expect(job.id).toBe(res.id);
  });

  test('delayMs routes the job to the delayed ZSET, not pending', async () => {
    await jobQueue.enqueue('email', { to: 'a@b.c' }, { delayMs: 5000 });
    expect(getList(PENDING_KEY)).toHaveLength(0);
    expect(getZ(DELAYED_KEY).size).toBe(1);
  });
});

describe('drainJobs', () => {
  test('runs each pending job and removes the successful ones', async () => {
    mockRunJob.mockResolvedValue(undefined);
    await jobQueue.enqueue('email', { n: 1 });
    await jobQueue.enqueue('email', { n: 2 });

    const result = await jobQueue.drainJobs();

    expect(result).toMatchObject({ processed: 2, succeeded: 2, retried: 0, failed: 0 });
    expect(mockRunJob).toHaveBeenCalledTimes(2);
    expect(getList(PENDING_KEY)).toHaveLength(0);
  });

  test('one failing job does not abort the batch (per-item isolation, task 3.5)', async () => {
    mockRunJob
      .mockRejectedValueOnce(new Error('bad recipient'))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    await jobQueue.enqueue('email', { n: 1 });
    await jobQueue.enqueue('email', { n: 2 });
    await jobQueue.enqueue('email', { n: 3 });

    const result = await jobQueue.drainJobs();

    expect(result.processed).toBe(3);
    expect(result.succeeded).toBe(2);
    expect(result.retried).toBe(1); // the failure went to the retry ZSET
    expect(mockRunJob).toHaveBeenCalledTimes(3);
  });

  test('a transient failure is retried with backoff, not dropped (task 3.2)', async () => {
    mockRunJob.mockRejectedValue(new Error('smtp timeout'));
    await jobQueue.enqueue('email', { n: 1 });

    const before = Date.now();
    const r1 = await jobQueue.drainJobs();
    expect(r1).toMatchObject({ processed: 1, succeeded: 0, retried: 1, failed: 0 });
    expect(getList(PENDING_KEY)).toHaveLength(0);

    const delayed = [...getZ(DELAYED_KEY).entries()];
    expect(delayed).toHaveLength(1);
    const [raw, readyAt] = delayed[0];
    expect(JSON.parse(raw).attempts).toBe(1);
    expect(readyAt).toBeGreaterThanOrEqual(before + 1000); // 1s backoff on attempt 1
  });

  test('a permanently failing job ends in the failed set + Sentry after MAX_ATTEMPTS', async () => {
    mockRunJob.mockRejectedValue(new Error('nope'));
    await jobQueue.enqueue('email', { n: 1 });

    // attempt 1 -> delayed, attempt 2 -> delayed, attempt 3 -> failed
    for (let i = 0; i < jobQueue.MAX_ATTEMPTS; i += 1) {
      // make the delayed job due
      const z = getZ(DELAYED_KEY);
      for (const m of z.keys()) z.set(m, 0);
      // eslint-disable-next-line no-await-in-loop
      await jobQueue.drainJobs();
    }

    expect(getList(PENDING_KEY)).toHaveLength(0);
    expect(getZ(DELAYED_KEY).size).toBe(0);
    const failed = getList(FAILED_KEY);
    expect(failed).toHaveLength(1);
    const job = JSON.parse(failed[0]);
    expect(job.attempts).toBe(jobQueue.MAX_ATTEMPTS);
    expect(job.lastError).toBe('nope');
    expect(job.failedAt).toBeDefined();
    expect(mockCapture).toHaveBeenCalledTimes(1);
  });

  test('promotes due delayed jobs back onto pending before processing', async () => {
    mockRunJob.mockResolvedValue(undefined);
    await jobQueue.enqueue('email', { n: 1 }, { delayMs: 1000 });
    // not due yet
    let r = await jobQueue.drainJobs();
    expect(r.promoted).toBe(0);
    expect(r.processed).toBe(0);
    // make it due
    for (const m of getZ(DELAYED_KEY).keys()) getZ(DELAYED_KEY).set(m, Date.now() - 1);
    r = await jobQueue.drainJobs();
    expect(r.promoted).toBe(1);
    expect(r.succeeded).toBe(1);
  });

  test('respects the max batch size', async () => {
    mockRunJob.mockResolvedValue(undefined);
    for (let i = 0; i < 5; i += 1) await jobQueue.enqueue('email', { n: i });
    const r = await jobQueue.drainJobs({ max: 2 });
    expect(r.processed).toBe(2);
    expect(getList(PENDING_KEY)).toHaveLength(3);
  });
});
