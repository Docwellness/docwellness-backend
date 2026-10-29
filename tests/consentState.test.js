const {
  currentConsents,
  buildEntries,
  isDuplicateOfLatest,
} = require('../utils/consentState');

const at = (iso) => new Date(iso);

describe('currentConsents', () => {
  test('empty list gives null for every type', () => {
    expect(currentConsents([])).toEqual({ healthData: null, analytics: null, crashReporting: null });
    expect(currentConsents(undefined)).toEqual({ healthData: null, analytics: null, crashReporting: null });
  });

  test('latest entry per type wins', () => {
    const entries = [
      { type: 'health_data', granted: true, policyVersion: '2026-09', source: 'signup', at: at('2026-09-01') },
      { type: 'health_data', granted: true, policyVersion: '2026-10', source: 'reprompt', at: at('2026-10-01') },
      { type: 'analytics', granted: true, policyVersion: '2026-10', source: 'settings', at: at('2026-10-02') },
    ];
    const state = currentConsents(entries);
    expect(state.healthData.policyVersion).toBe('2026-10');
    expect(state.analytics.granted).toBe(true);
    expect(state.crashReporting).toBeNull();
  });

  test('a withdrawal after a grant is the current state', () => {
    const entries = [
      { type: 'health_data', granted: true, policyVersion: '2026-10', source: 'signup', at: at('2026-10-01') },
      { type: 'health_data', granted: false, policyVersion: '2026-10', source: 'settings', at: at('2026-10-05') },
    ];
    expect(currentConsents(entries).healthData).toEqual({
      granted: false,
      policyVersion: '2026-10',
      at: at('2026-10-05'),
    });
  });
});

describe('buildEntries', () => {
  const now = at('2026-10-28T10:00:00Z');

  test('stamps source and server time, ignoring a client timestamp', () => {
    const [entry] = buildEntries(
      [{ type: 'health_data', granted: true, policyVersion: '2026-10', at: '1999-01-01' }],
      'signup',
      now
    );
    expect(entry).toEqual({
      type: 'health_data',
      granted: true,
      policyVersion: '2026-10',
      source: 'signup',
      at: now,
    });
  });

  test('rejects an unknown type', () => {
    expect(() => buildEntries([{ type: 'marketing', granted: true, policyVersion: '1' }], 'signup', now)).toThrow(
      /Unknown consent type/
    );
  });

  test('rejects an unknown source', () => {
    expect(() => buildEntries([], 'import', now)).toThrow(/Unknown consent source/);
  });

  test('empty list gives no entries', () => {
    expect(buildEntries([], 'settings', now)).toEqual([]);
  });
});

describe('isDuplicateOfLatest', () => {
  const entries = [
    { type: 'analytics', granted: true, policyVersion: '2026-10', source: 'settings', at: at('2026-10-01') },
  ];

  test('true when granted flag and version match the latest', () => {
    expect(isDuplicateOfLatest(entries, { type: 'analytics', granted: true, policyVersion: '2026-10' })).toBe(true);
  });

  test('false when the flag, version or type differs', () => {
    expect(isDuplicateOfLatest(entries, { type: 'analytics', granted: false, policyVersion: '2026-10' })).toBe(false);
    expect(isDuplicateOfLatest(entries, { type: 'analytics', granted: true, policyVersion: '2027-01' })).toBe(false);
    expect(isDuplicateOfLatest(entries, { type: 'health_data', granted: true, policyVersion: '2026-10' })).toBe(false);
  });
});
