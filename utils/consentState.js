/**
 * Pure helpers for the append-only `User.consents` log.
 * The server sets every timestamp; a client-supplied `at` is never used.
 */

const CONSENT_TYPES = ['health_data', 'analytics', 'crash_reporting'];
const CONSENT_SOURCES = ['signup', 'reprompt', 'settings'];

// API key (camelCase) per stored type, as returned by GET /consent and /auth/me.
const SUMMARY_KEYS = {
  health_data: 'healthData',
  analytics: 'analytics',
  crash_reporting: 'crashReporting',
};

/** Latest entry per type: `{ [type]: entry }` (the log is in append order). */
function latestByType(entries) {
  const latest = {};
  for (const entry of entries || []) {
    latest[entry.type] = entry;
  }
  return latest;
}

/** Current state per type for the API: `{ healthData, analytics, crashReporting }`, null when never recorded. */
function currentConsents(entries) {
  const latest = latestByType(entries);
  const summary = {};
  for (const type of CONSENT_TYPES) {
    const entry = latest[type];
    summary[SUMMARY_KEYS[type]] = entry
      ? { granted: entry.granted, policyVersion: entry.policyVersion, at: entry.at }
      : null;
  }
  return summary;
}

/**
 * Validate `inputs` (`[{ type, granted, policyVersion }]`) and build entries
 * stamped with `source` and the server time `now`. Throws on an unknown type
 * or source.
 */
function buildEntries(inputs, source, now = new Date()) {
  if (!CONSENT_SOURCES.includes(source)) {
    throw new Error(`Unknown consent source: ${source}`);
  }
  return (inputs || []).map((input) => {
    if (!CONSENT_TYPES.includes(input.type)) {
      throw new Error(`Unknown consent type: ${input.type}`);
    }
    return {
      type: input.type,
      granted: input.granted === true,
      policyVersion: String(input.policyVersion),
      source,
      at: now,
    };
  });
}

/** True when the latest entry for the input's type already has the same granted flag and version. */
function isDuplicateOfLatest(entries, input) {
  const latest = latestByType(entries)[input.type];
  return Boolean(
    latest && latest.granted === (input.granted === true) && latest.policyVersion === input.policyVersion
  );
}

module.exports = {
  CONSENT_TYPES,
  CONSENT_SOURCES,
  currentConsents,
  buildEntries,
  isDuplicateOfLatest,
};
