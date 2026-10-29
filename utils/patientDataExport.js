/**
 * Builds the patient's self-service data export (portability / right of access).
 *
 * Scope is the deletion module's: for every key in CATEGORY_KEYS the records
 * are resolved through the same per-category filters (`specsForCategory`), so
 * "what is exported" and "what is erased" cannot drift apart. The user block
 * is an explicit allowlist, so a field added to User later is excluded by
 * default. Built in memory per request; nothing here logs or stores contents.
 */

const { CATEGORY_KEYS, specsForCategory } = require('./patientDataDeletion');

const EXPORT_VERSION = 1;
// Per-collection cap so one account cannot exhaust memory (chat and logs).
const MAX_RECORDS_PER_COLLECTION = 20000;

function exportUserBlock(user) {
  const plain = typeof user.toObject === 'function' ? user.toObject() : user;
  return {
    email: plain.email,
    profile: plain.profile,
    healthProfile: plain.healthProfile,
    status: plain.status,
    consents: plain.consents || [],
    createdAt: plain.createdAt,
  };
}

/**
 * @param {Object} user  the authenticated patient (Mongoose doc or plain object)
 * @param {Object} [opts]
 * @param {number} [opts.maxRecords]  per-collection cap (default 20 000)
 * @returns {Promise<{ document: Object, counts: Object }>} the export and
 *          `{ [category]: recordCount }` for the audit event
 */
async function buildPatientExport(user, { maxRecords = MAX_RECORDS_PER_COLLECTION } = {}) {
  const categories = {};
  const counts = {};
  let truncated = false;

  for (const key of CATEGORY_KEYS) {
    const collections = {};
    let total = 0;
    let categoryTruncated = false;

    for (const spec of await specsForCategory(key, [user._id])) {
      const records = await spec.Model.find(spec.filter).limit(maxRecords + 1).lean();
      if (records.length > maxRecords) {
        records.length = maxRecords;
        categoryTruncated = true;
      }
      collections[spec.coll] = records;
      total += records.length;
    }

    categories[key] = { count: total, truncated: categoryTruncated, collections };
    counts[key] = total;
    truncated = truncated || categoryTruncated;
  }

  return {
    document: {
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      truncated,
      user: exportUserBlock(user),
      categories,
    },
    counts,
  };
}

module.exports = { buildPatientExport, MAX_RECORDS_PER_COLLECTION, EXPORT_VERSION };
