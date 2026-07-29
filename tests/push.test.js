// Confirms utils/push.js degrades gracefully (same convention as
// utils/redisClient.js) when FCM_SERVICE_ACCOUNT_BASE64 isn't configured -
// which is always true in this test environment (see tests/helpers/testDb.js,
// no such var is set there).

describe('utils/push (unconfigured)', () => {
  let push;

  beforeAll(() => {
    push = require('../utils/push');
  });

  test('isEnabled() is false with no FCM_SERVICE_ACCOUNT_BASE64 configured', () => {
    expect(push.isEnabled()).toBe(false);
  });

  test('sendPushToTokens resolves without throwing and calls no callback', async () => {
    const onInvalidToken = jest.fn();
    await expect(
      push.sendPushToTokens(['fake-token'], { title: 't', body: 'b' }, onInvalidToken)
    ).resolves.toBeUndefined();
    expect(onInvalidToken).not.toHaveBeenCalled();
  });

  test('sendPushToTokens is a no-op for an empty token list', async () => {
    await expect(push.sendPushToTokens([], { title: 't', body: 'b' })).resolves.toBeUndefined();
  });
});
