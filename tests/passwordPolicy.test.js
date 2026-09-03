/**
 * Password policy (auth-spec-audit follow-up #3) - utils/passwordPolicy.
 * Pure unit tests; the HTTP wiring is covered by passwordPolicyRoutes.test.js.
 */

const crypto = require('crypto');

const realFetch = global.fetch;
const mockFetch = jest.fn();
global.fetch = mockFetch;
afterAll(() => {
  global.fetch = realFetch;
});

const {
  MIN_LENGTH,
  validatePasswordStrength,
  isPasswordBreached,
  assertPasswordAcceptable,
} = require('../utils/passwordPolicy');

const sha1Upper = (s) => crypto.createHash('sha1').update(s, 'utf8').digest('hex').toUpperCase();
/** A HIBP range-API body that reports `password` as breached. */
const breachedBody = (password) => `${sha1Upper(password).slice(5)}:99`;

beforeEach(() => {
  mockFetch.mockReset();
});

describe('validatePasswordStrength', () => {
  const strong = 'Correct-Horse-9Battery';

  test('accepts a strong password', () => {
    expect(validatePasswordStrength(strong)).toBeNull();
  });

  test.each([
    ['', 'empty'],
    ['Ab1!x', 'length 5'],
    ['Abcdefghij1', `length ${MIN_LENGTH - 1}`],
  ])('rejects %j (%s)', (pw) => {
    expect(validatePasswordStrength(pw)).toMatch(/at least 12/);
  });

  test('rejects fewer than 3 character classes', () => {
    expect(validatePasswordStrength('alllowercaseletters')).toMatch(/three of/);
    expect(validatePasswordStrength('ALLUPPERCASELETTERS')).toMatch(/three of/);
    expect(validatePasswordStrength('nouppercase12345')).toMatch(/three of/); // lower + number only
  });

  test('accepts exactly 3 classes', () => {
    expect(validatePasswordStrength('lowerUPPER12345')).toBeNull();
  });

  test('rejects a short repeated sequence that otherwise passes', () => {
    expect(validatePasswordStrength('Ab1!Ab1!Ab1!')).toMatch(/too simple/); // 3 classes, 12 chars
    expect(validatePasswordStrength('AbC-AbC-AbC-AbC-')).toMatch(/too simple/);
  });

  test('rejects a password containing the email local-part', () => {
    expect(
      validatePasswordStrength('john.doe-Str0ng!', { email: 'john.doe@example.com' })
    ).toMatch(/email address/);
  });

  test('rejects a password containing a name part', () => {
    expect(
      validatePasswordStrength('Priya-is-Str0ng!', { name: 'Priya Sharma' })
    ).toMatch(/your name/);
  });

  test('a <3 char name part is not matched (avoids false positives)', () => {
    expect(validatePasswordStrength('AbXyZ-9-plenty', { name: 'Al B' })).toBeNull();
  });
});

describe('isPasswordBreached', () => {
  test('true when the hash suffix is in the HIBP range response', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => `0000000000000000000000000000000000A:1\r\n${breachedBody('password')}`,
    });
    expect(await isPasswordBreached('password')).toBe(true);
    expect(mockFetch.mock.calls[0][0]).toBe(
      `https://api.pwnedpasswords.com/range/${sha1Upper('password').slice(0, 5)}`
    );
  });

  test('false when the suffix is absent', async () => {
    mockFetch.mockResolvedValue({ ok: true, text: async () => 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:3' });
    expect(await isPasswordBreached('whatever')).toBe(false);
  });

  test('false (best-effort) on a network error', async () => {
    mockFetch.mockRejectedValue(new Error('ENOTFOUND'));
    expect(await isPasswordBreached('password')).toBe(false);
  });

  test('false on a non-ok response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503, text: async () => '' });
    expect(await isPasswordBreached('password')).toBe(false);
  });
});

describe('assertPasswordAcceptable', () => {
  test('resolves for a strong, unbreached password', async () => {
    mockFetch.mockResolvedValue({ ok: true, text: async () => 'DEADBEEF:1' });
    await expect(assertPasswordAcceptable('lowerUPPER-45678', { email: 'a@b.com' })).resolves.toBeUndefined();
  });

  test('throws weak_password for a short password (no HIBP call)', async () => {
    await expect(assertPasswordAcceptable('short1!', {})).rejects.toMatchObject({
      code: 'weak_password',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('throws weak_password when HIBP reports a strong-but-breached password', async () => {
    const pw = 'lowerUPPER-12345'; // passes strength (4 classes, 15 chars)
    mockFetch.mockResolvedValue({ ok: true, text: async () => breachedBody(pw) });
    await expect(assertPasswordAcceptable(pw, {})).rejects.toMatchObject({
      code: 'weak_password',
      message: expect.stringMatching(/data breach/),
    });
  });
});
