/**
 * Email off the request path - cross-app performance optimization, Phase 3
 * (task 3.3). Verifies utils/emailService.dispatchEmail and the OTP
 * templates: the triggering action must still succeed / respond when Resend
 * fails, and the send must be handed to the retry queue rather than lost.
 */

// Controllable Resend stub.
let mockSendImpl = jest.fn();
jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: { send: (...args) => mockSendImpl(...args) },
  })),
}));

// In-memory Redis (lists only - that's all enqueue touches here).
const lists = new Map();
const getList = (k) => {
  if (!lists.has(k)) lists.set(k, []);
  return lists.get(k);
};
const mockRedis = {
  async rpush(k, v) {
    return getList(k).push(v);
  },
  async zadd() {
    return 1;
  },
};
jest.mock('../utils/redisClient', () => ({ client: mockRedis, isEnabled: true }));

const emailService = require('../utils/emailService');
const { PENDING_KEY } = require('../utils/jobQueue')._keys;

beforeEach(() => {
  lists.clear();
  mockSendImpl = jest.fn();
});

describe('dispatchEmail', () => {
  const spec = { to: 'p@example.test', subject: 'Hi', text: 'hi', html: '<p>hi</p>' };

  test('urgent: a successful inline send does not touch the queue', async () => {
    mockSendImpl.mockResolvedValue({ data: { id: 'msg_1' }, error: null });

    const res = await emailService.dispatchEmail(spec, { urgent: true });

    expect(mockSendImpl).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ id: 'msg_1' });
    expect(getList(PENDING_KEY)).toHaveLength(0);
  });

  test('urgent: a failing send is queued for retry and never throws', async () => {
    mockSendImpl.mockRejectedValue(new Error('resend 503'));

    const res = await emailService.dispatchEmail(spec, { urgent: true });

    expect(res).toEqual({ queued: true });
    const queued = getList(PENDING_KEY);
    expect(queued).toHaveLength(1);
    const job = JSON.parse(queued[0]);
    expect(job.type).toBe('email');
    expect(job.payload).toMatchObject({ to: 'p@example.test', subject: 'Hi' });
  });

  test('non-urgent: goes straight to the queue, no inline send', async () => {
    mockSendImpl.mockResolvedValue({ data: { id: 'x' }, error: null });

    const res = await emailService.dispatchEmail(spec);

    expect(mockSendImpl).not.toHaveBeenCalled();
    expect(res).toEqual({ queued: true });
    expect(getList(PENDING_KEY)).toHaveLength(1);
  });
});

describe('OTP templates stay non-fatal when Resend is down', () => {
  test('sendSignupOtp resolves (queued) instead of throwing', async () => {
    mockSendImpl.mockRejectedValue(new Error('resend down'));

    await expect(emailService.sendSignupOtp('new@example.test', '123456')).resolves.toEqual({
      queued: true,
    });
    const job = JSON.parse(getList(PENDING_KEY)[0]);
    expect(job.payload.to).toBe('new@example.test');
    expect(job.payload.text).toContain('123456');
  });

  test('sendPasswordResetOtp resolves (queued) instead of throwing', async () => {
    mockSendImpl.mockRejectedValue(new Error('resend down'));

    await expect(
      emailService.sendPasswordResetOtp({ email: 'u@example.test', profile: { fullName: 'U' } }, '999000')
    ).resolves.toEqual({ queued: true });
    expect(getList(PENDING_KEY)).toHaveLength(1);
  });

  test('sendSignupOtp sends inline (no queue) on the happy path', async () => {
    mockSendImpl.mockResolvedValue({ data: { id: 'ok' }, error: null });

    await emailService.sendSignupOtp('new@example.test', '123456');

    expect(mockSendImpl).toHaveBeenCalledTimes(1);
    expect(getList(PENDING_KEY)).toHaveLength(0);
  });
});
