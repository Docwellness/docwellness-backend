/**
 * Fills the nine micronutrients (saturatedFat, transFat, sugar, cholesterol,
 * sodium, calcium, iron, potassium, vitaminC) into whichever MongoDB this
 * script is run against. openspec/changes/fill-recipe-micronutrients,
 * design.md Decisions 3, 4(c), 5, 8 and 10 (tasks 6.1-6.4, 6b.5).
 *
 * Meant to be run directly in the target environment (a Coolify terminal for
 * prod) - same convention as migrate-recipe-images-batch1.js. Uses
 * config/database.js's connectDB() (prod's private-CA TLS), never a bare
 * mongoose.connect(uri). Prints no connection string or .env value.
 *
 * Phases, run in this order (--phase=all, the default; with --execute it also
 * needs --yes-all, see Usage):
 *   fooditems  scripts/data/fooditem-micronutrients.json -> FoodItem
 *              nutritionPer100g.<nutrient> + micronutrientProvenance.<nutrient>.
 *              Matched on normalizedName. Written only where the DB value is
 *              null/absent; an equal value is a no-op; a DIFFERENT non-null
 *              value is a `conflict`, left untouched.
 *   versions   RecipeVersion.nutritionPerServing.<nutrient> (+
 *              micronutrientsIncomplete), recomputed from each version's own
 *              frozen ingredients[] via computeMicronutrientsForVersion.
 *              Targeted $set only (timestamps untouched): no re-save, no
 *              version bump, never touches ingredients, macros or versionNumber.
 *   recipes    Recipe.nutrition.<n> and Recipe.nutritionPerServing.<n> copied
 *              from V1, plus optional reviewed fallback values (below).
 *              updateOne only, never .save(), so syncV1FromRecipe never fires.
 *
 * Rules that hold in every phase: dry run by default (nothing written, no
 * backup file); `--execute` writes; a non-null DB value is NEVER overwritten
 * (a differing one is a `conflict`, listed as a candidate change for review);
 * a null computed/researched value is never written (no invented zeros, and a
 * manifest or fallback 0 is accepted only with an explicit verified-zero
 * marker, see below); re-running after a successful run reports only
 * already-correct no-ops.
 *
 * Later phases in `--phase=all`: a dry run feeds each phase the earlier
 * phases' PROJECTED values so the whole picture shows. With --execute nothing
 * is projected: each phase reads the database, so it only ever sees values
 * that were actually written (a failed backup or a failed record write leaks
 * nothing downstream).
 *
 * Dietician-verified recipes (design.md Decision 10, task 6b.5): the Recipe
 * schema has NO verified field today (tasks.md 6b.1), so "verified" is read as
 * `isVerified ?? verified` (same as scripts/export-recipes-prod.js) and is
 * shown in the log as true/false/unknown. Because it is unknown for every
 * recipe today, the conservative rule (fill only absent/null, never
 * overwrite, list candidate changes) is applied to ALL recipes, verified or
 * not. A stored literal 0 on sodium/potassium/calcium that disagrees with the
 * candidate is flagged as likely implausible in the conflict listing, but is
 * still not overwritten.
 *
 * Fallback values (6b.5): `--fallback=<file>` accepts a reviewed JSON file
 *   { "<recipeId>": { "<nutrient>": { "value": 12.3, "confidence": "low",
 *     "method": "estimated" } } }
 * for recipes whose ingredients do not resolve to a FoodItem. Used by the
 * `recipes` phase only, and only where the recipe's V1 has no value for that
 * nutrient. Never written to RecipeVersion. There is no second backfill script.
 * A `value` of 0 is rejected unless the entry also carries `"verifiedZero": true`
 * (a reviewed marker). The file is read and validated before the DB connects.
 *
 * Backup (6b.5): with --execute, before a phase writes anything, the old
 * value of every path it is about to change (plus the value it will write) is
 * saved to <backup dir>/micronutrient-migration-backup-<timestamp>-<phase>.json
 * (default dir `.cache/`, git-ignored; override with --backup-dir=<dir>).
 * If the backup cannot be written the phase writes nothing and reports an error.
 * On a deployed box the default `.cache/` lives inside the container, which a
 * Coolify redeploy or restart wipes, and `--rollback` needs that file: pass
 * --backup-dir=<dir on a persistent volume>, or copy each phase's backup file
 * off the box before the next step.
 * Each backed-up change also carries `source` (V1 or the fallback description)
 * and, for a fallback value, `fallback: { method, confidence }`, so estimated
 * values stay identifiable after the run.
 *
 * Rollback: `--rollback --phase=<one phase> --backup=<backup file>` (dry run
 * by default, `--execute` to apply). Restores the backed-up old values, but
 * only where the current value still equals what this script wrote, so a
 * later manual edit is reported as a `conflict`, not clobbered. The same guard
 * covers provenance paths: a provenance entry edited since the migration is a
 * `conflict`. A provenance entry that still equals what the script wrote is
 * restored (or unset) even when its value is already back to the old value
 * (orphaned provenance), but is left alone when its value is a `conflict`.
 * This is the rollback design.md describes (Migration Plan): a precise restore
 * from the backup, not a blanket $unset.
 *
 * Atomic never-overwrite: each write is conditional. The updateOne filter also
 * requires every path it $sets to still be null/absent (`{path: null}` matches
 * both), a micronutrientsIncomplete list to still equal what was read, and a
 * provenance entry that existed to still have the status/confidence/researchedAt
 * that was read. Rollback writes are conditional on the current value still
 * equalling what was read. A record whose filter matches nothing (edited or
 * deleted between the read and the write) is NOT written and is reported as a
 * `conflict` with a RACED line; re-run a dry run to see the new state.
 *
 * Usage (from the repo root):
 *   node scripts/migrate-fooditem-micronutrients-prod.js [--phase=fooditems|versions|recipes|all]
 *   node scripts/migrate-fooditem-micronutrients-prod.js --phase=fooditems --execute
 *   --only=<normalizedName>   (fooditems)  or  --only=<recipeId>  (versions, recipes)
 *   --fallback=<file>  --backup-dir=<dir>  --include-bulk
 *   --rollback --phase=<phase> --backup=<file> [--execute]
 *
 * --execute with --phase=all (also the default phase) is refused unless you
 * also pass --yes-all: run the phases one at a time (dry run first, read it,
 * then --execute) in the order fooditems, versions, recipes. --yes-all is only
 * for a run whose dry run you have already read. Dry runs and single-phase
 * --execute are unaffected.
 *
 * Bulk values: manifest entries whose provenance is only the `_bulk` fallback
 * (no per-field entry) lack real citations; their notes say they are "not
 * independently web-verified". By default those fields are SKIPPED (not written,
 * no provenance, noted in the log), so the versions and recipes phases only see
 * values actually written or projected. `--include-bulk` opts in to writing
 * them as `researched` with confidence `low` (whatever the manifest says); use
 * it only after the developer has accepted that. A 0 needs provenance status
 * `verified-zero` in every case, bulk included, otherwise it is skipped.
 *
 * Exit code: non-zero if any record errored. conflict / not-found are
 * reported, not failures. ALWAYS dry-run first and read the output.
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { normalize } = require('../utils/ingredientLibrary');
const { MICRONUTRIENT_FIELDS, computeMicronutrientsForVersion } = require('../services/recipeVersioningService');

const PHASES = ['fooditems', 'versions', 'recipes'];
const MANIFEST_PATH = path.join(__dirname, 'data', 'fooditem-micronutrients.json');
const DEFAULT_BACKUP_DIR = path.join(__dirname, '..', '.cache');
const ZERO_IMPLAUSIBLE = ['sodium', 'potassium', 'calcium'];
const STATUSES = ['updated', 'alreadyCorrect', 'notFound', 'conflict', 'skippedNullData', 'errors'];
const STATUS_LABELS = {
  updated: 'updated',
  alreadyCorrect: 'already-correct (no-op)',
  notFound: 'not-found',
  conflict: 'conflict',
  skippedNullData: 'skipped-null-data',
  errors: 'errors',
};

const isMissing = (value) => value === null || value === undefined;
const sameNumber = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9;
const getPath = (doc, dotted) => dotted.split('.').reduce((node, key) => (isMissing(node) ? undefined : node[key]), doc);
const isProvenancePath = (p) => p.startsWith('micronutrientProvenance.');
const show = (value) => (value === undefined ? '(absent)' : JSON.stringify(value));
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Provenance as the database stores it (schema defaults, sub-document _ids)
// versus as the backup recorded it: compare only the meaningful fields.
function provenanceView(p) {
  if (isMissing(p)) return null;
  return {
    status: p.status ?? 'unknown',
    confidence: p.confidence ?? 'low',
    method: p.method ?? 'single-source',
    note: p.note ?? null,
    researchedAt: p.researchedAt ? new Date(p.researchedAt).toISOString() : null,
    sources: (p.sources || []).map((s) => ({ name: s.name ?? null, ref: s.ref ?? null, value: s.value ?? null, basis: s.basis ?? 'raw' })),
  };
}
const sameStored = (p, a, b) => JSON.stringify(isProvenancePath(p) ? provenanceView(a) : a) === JSON.stringify(isProvenancePath(p) ? provenanceView(b) : b);

function parseArgs(argv) {
  const flag = (name) => argv.includes(`--${name}`);
  const value = (name) => (argv.find((a) => a.startsWith(`--${name}=`)) || '').slice(name.length + 3) || null;
  const phase = value('phase') || 'all';
  if (phase !== 'all' && !PHASES.includes(phase)) throw new Error(`--phase must be one of ${PHASES.join('|')}|all`);
  const opts = {
    execute: flag('execute'),
    rollback: flag('rollback'),
    includeBulk: flag('include-bulk'),
    yesAll: flag('yes-all'),
    only: value('only'),
    phase,
    fallbackFile: value('fallback'),
    backupDir: value('backup-dir') || DEFAULT_BACKUP_DIR,
    backupFile: value('backup'),
  };
  if (opts.rollback && (phase === 'all' || !opts.backupFile)) {
    throw new Error('--rollback needs one --phase=<fooditems|versions|recipes> and --backup=<backup file>');
  }
  if (opts.execute && !opts.rollback && phase === 'all' && !opts.yesAll) {
    throw new Error('--execute with --phase=all writes every phase in one go. Run the phases one at a time instead (--phase=fooditems, then versions, then recipes; dry run first, then --execute), or pass --yes-all if you have already read the dry run.');
  }
  return opts;
}

const MANIFEST_ENTRY_KEYS = [...MICRONUTRIENT_FIELDS, 'provenance', 'note'];

function validateManifest(manifest) {
  for (const [name, entry] of Object.entries(manifest)) {
    if (!isPlainObject(entry)) throw new Error(`manifest ${name}: must be an object keyed by nutrient`);
    for (const [key, value] of Object.entries(entry)) {
      if (!MANIFEST_ENTRY_KEYS.includes(key)) throw new Error(`manifest ${name}: unknown nutrient "${key}"`);
      if (MICRONUTRIENT_FIELDS.includes(key) && !isMissing(value) && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
        throw new Error(`manifest ${name}.${key}: value must be a finite number >= 0 (or null for not researched), got ${JSON.stringify(value)}`);
      }
    }
    if (!isMissing(entry.provenance)) {
      if (!isPlainObject(entry.provenance)) throw new Error(`manifest ${name}.provenance: must be an object keyed by nutrient`);
      for (const key of Object.keys(entry.provenance)) {
        // `_bulk` is the fallback entry; other `_`-prefixed keys (e.g. `_note`) are comments.
        if (!key.startsWith('_') && !MICRONUTRIENT_FIELDS.includes(key)) throw new Error(`manifest ${name}.provenance: unknown nutrient "${key}"`);
      }
    }
  }
}

function loadManifest(file = MANIFEST_PATH) {
  const { _meta, ...entries } = JSON.parse(fs.readFileSync(file, 'utf8'));
  validateManifest(entries);
  return entries;
}

function loadFallback(file) {
  if (!file) return {};
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isPlainObject(raw)) throw new Error('fallback file must be a JSON object keyed by recipe id');
  for (const [recipeId, nutrients] of Object.entries(raw)) {
    if (!isPlainObject(nutrients)) throw new Error(`fallback ${recipeId}: must be an object keyed by nutrient`);
    for (const [field, entry] of Object.entries(nutrients)) {
      if (!MICRONUTRIENT_FIELDS.includes(field)) throw new Error(`fallback ${recipeId}: unknown nutrient "${field}"`);
      if (!isPlainObject(entry)) throw new Error(`fallback ${recipeId}.${field}: must be an object with a numeric "value"`);
      if (typeof entry.value !== 'number' || !Number.isFinite(entry.value) || entry.value < 0) {
        throw new Error(`fallback ${recipeId}.${field}: value must be a finite number >= 0`);
      }
      if (entry.value === 0 && entry.verifiedZero !== true) {
        throw new Error(`fallback ${recipeId}.${field}: a value of 0 needs "verifiedZero": true (reviewed marker), else leave it out`);
      }
    }
  }
  return raw;
}

// --only matches a record id; an --only that is not an ObjectId (e.g. a
// normalizedName meant for the fooditems phase) matches nothing here.
function idFilter(only, ...fields) {
  if (!only) return {};
  if (!mongoose.Types.ObjectId.isValid(only)) return { _id: null };
  return { $or: fields.map((field) => ({ [field]: only })) };
}

function newResult(label, id) {
  return { label, id, status: null, changes: [], conflicts: [], notes: [] };
}

function classify(result, hadCandidates) {
  if (result.conflicts.length) return 'conflict';
  if (result.changes.length) return 'updated';
  return hadCandidates ? 'alreadyCorrect' : 'skippedNullData';
}

// ---------------------------------------------------------------- fooditems

async function planFoodItems({ FoodItem, manifest, only, runDate, includeBulk = false }) {
  const results = [];
  const projected = new Map(); // foodItemId -> nutritionPer100g after this run's writes
  const wanted = only ? normalize(only) : null;

  for (const [name, entry] of Object.entries(manifest)) {
    const normalizedName = normalize(name);
    if (wanted && normalizedName !== wanted) continue;
    const result = newResult(name);
    results.push(result);
    try {
      const doc = await FoodItem.findOne({ normalizedName }).select('name nutritionPer100g micronutrientProvenance').lean();
      if (!doc) {
        result.status = 'notFound';
        continue;
      }
      result.id = doc._id;
      const merged = { ...(doc.nutritionPer100g || {}) };
      let hadCandidates = false;

      for (const field of MICRONUTRIENT_FIELDS) {
        const value = entry[field];
        if (isMissing(value)) continue;
        const ownProv = entry.provenance?.[field];
        const prov = ownProv ?? entry.provenance?._bulk;
        if (!prov || prov.status === 'unknown') {
          result.notes.push(`${field}: value has no usable provenance entry, skipped`);
          continue;
        }
        if (!ownProv && !includeBulk) {
          result.notes.push(`${field}: unverified _bulk provenance, skipped (pass --include-bulk to apply)`);
          continue;
        }
        if (value === 0 && prov.status !== 'verified-zero') {
          result.notes.push(`${field}: value 0 without verified-zero provenance, skipped`);
          continue;
        }
        hadCandidates = true;
        const current = doc.nutritionPer100g?.[field];
        const hasProvenance = !isMissing(doc.micronutrientProvenance?.[field]);

        if (!isMissing(current) && !sameNumber(current, value)) {
          result.conflicts.push({ path: `nutritionPer100g.${field}`, current, candidate: value });
          continue;
        }
        if (isMissing(current)) {
          result.changes.push({ path: `nutritionPer100g.${field}`, before: current ?? null, existed: current !== undefined, after: value });
          merged[field] = value;
        }
        if (isMissing(current) || !hasProvenance) {
          // A value backed only by the unverified _bulk fallback is never recorded above `low`.
          const { status, sources, method, note } = prov;
          const confidence = ownProv ? prov.confidence : 'low';
          const provenance = { status, sources: sources || [], confidence, method, note, researchedAt: new Date(prov.researchedAt || runDate) };
          const existing = doc.micronutrientProvenance?.[field];
          result.changes.push({ path: `micronutrientProvenance.${field}`, before: existing ?? null, existed: existing !== undefined, after: provenance });
        }
      }
      projected.set(String(doc._id), merged);
      result.status = classify(result, hadCandidates);
    } catch (err) {
      result.status = 'errors';
      result.notes.push(`unexpected error: ${err.message}`);
    }
  }
  return { results, projected };
}

// ----------------------------------------------------------------- versions

async function planVersions({ RecipeVersion, FoodItem, only, projectedFoodItems }) {
  const results = [];
  const projectedV1 = new Map(); // parentRecipeId -> V1 micronutrients after this run's writes

  const versions = await RecipeVersion.find(idFilter(only, 'parentRecipeId', '_id'))
    .select('name parentRecipeId versionNumber ingredients nutritionPerServing micronutrientsIncomplete')
    .lean();
  const foodItemIds = [...new Set(versions.flatMap((v) => (v.ingredients || []).map((i) => String(i.foodItemId))))];
  const foodItems = await FoodItem.find({ _id: { $in: foodItemIds } }).select('name nutritionPer100g unitConversions density').lean();
  const foodItemsById = new Map(foodItems.map((f) => [String(f._id), f]));
  for (const [id, nutritionPer100g] of projectedFoodItems || []) {
    if (foodItemsById.has(id)) foodItemsById.set(id, { ...foodItemsById.get(id), nutritionPer100g });
  }

  for (const version of versions) {
    const result = newResult(`${version.name} v${version.versionNumber}`, version._id);
    results.push(result);
    try {
      const { micronutrients, micronutrientsIncomplete } = computeMicronutrientsForVersion(version, foodItemsById);
      const stored = version.nutritionPerServing || {};
      const final = {};
      let hadCandidates = false;

      for (const field of MICRONUTRIENT_FIELDS) {
        const computed = micronutrients[field];
        final[field] = stored[field] ?? null;
        if (isMissing(computed)) continue;
        hadCandidates = true;
        if (isMissing(stored[field])) {
          result.changes.push({ path: `nutritionPerServing.${field}`, before: stored[field] ?? null, existed: stored[field] !== undefined, after: computed });
          final[field] = computed;
        } else if (!sameNumber(stored[field], computed)) {
          result.conflicts.push({ path: `nutritionPerServing.${field}`, current: stored[field], candidate: computed });
        }
      }

      // Audit list: only written when this version actually has computed data.
      const incomplete = micronutrientsIncomplete.filter((field) => isMissing(final[field]));
      const storedIncomplete = version.micronutrientsIncomplete;
      if (hadCandidates && [...incomplete].sort().join() !== [...(storedIncomplete || [])].sort().join()) {
        result.changes.push({ path: 'micronutrientsIncomplete', before: storedIncomplete ?? null, existed: storedIncomplete !== undefined, after: incomplete });
      }
      if (version.versionNumber === 1) projectedV1.set(String(version.parentRecipeId), final);
      result.status = classify(result, hadCandidates);
    } catch (err) {
      result.status = 'errors';
      result.notes.push(`unexpected error: ${err.message}`);
    }
  }
  return { results, projectedV1 };
}

// ------------------------------------------------------------------ recipes

async function planRecipes({ Recipe, RecipeVersion, only, projectedV1, fallback }) {
  const results = [];
  const recipes = await Recipe.find(idFilter(only, '_id')).select('name nutrition nutritionPerServing isVerified verified').lean();
  const v1Docs = await RecipeVersion.find({ versionNumber: 1, parentRecipeId: { $in: recipes.map((r) => r._id) } })
    .select('parentRecipeId nutritionPerServing')
    .lean();
  const v1ById = new Map(v1Docs.map((v) => [String(v.parentRecipeId), v.nutritionPerServing || {}]));

  for (const recipe of recipes) {
    const id = String(recipe._id);
    const verified = recipe.isVerified ?? recipe.verified;
    const result = newResult(`${recipe.name} [verified: ${isMissing(verified) ? 'unknown' : verified}]`, recipe._id);
    results.push(result);
    try {
      const v1 = projectedV1?.get(id) ?? v1ById.get(id);
      const recipeFallback = fallback[id];
      if (!v1 && !recipeFallback) {
        result.status = 'notFound';
        result.notes.push('no V1 RecipeVersion and no fallback values');
        continue;
      }
      let hadCandidates = false;

      for (const field of MICRONUTRIENT_FIELDS) {
        let candidate = v1?.[field];
        let source = 'V1';
        let fallbackInfo;
        if (isMissing(candidate) && recipeFallback?.[field]) {
          const { value, confidence, method } = recipeFallback[field];
          candidate = value;
          fallbackInfo = { method: method || 'estimated', confidence: confidence || 'unstated' };
          source = `fallback (${fallbackInfo.method}, confidence ${fallbackInfo.confidence})`;
        }
        if (isMissing(candidate)) continue;
        hadCandidates = true;

        for (const target of ['nutrition', 'nutritionPerServing']) {
          const current = recipe[target]?.[field];
          const dotted = `${target}.${field}`;
          if (isMissing(current)) {
            result.changes.push({ path: dotted, before: current ?? null, existed: current !== undefined, after: candidate, source, fallback: fallbackInfo });
          } else if (!sameNumber(current, candidate)) {
            const suspect = current === 0 && ZERO_IMPLAUSIBLE.includes(field) ? 'stored 0 looks implausible' : '';
            result.conflicts.push({ path: dotted, current, candidate, note: suspect });
          }
        }
      }
      result.status = classify(result, hadCandidates);
    } catch (err) {
      result.status = 'errors';
      result.notes.push(`unexpected error: ${err.message}`);
    }
  }

  // Reviewed fallback values for a recipe id this database does not have.
  const seen = new Set(recipes.map((r) => String(r._id)));
  for (const id of Object.keys(fallback)) {
    if (seen.has(id) || (only && only !== id)) continue;
    const result = newResult(`fallback ${id}`, id);
    result.status = 'notFound';
    result.notes.push('fallback entry for a recipe not in this database');
    results.push(result);
  }
  return { results };
}

// ----------------------------------------------------------------- commit

function logResult(result, log) {
  if (!result.changes.length && !result.conflicts.length && !result.notes.length) return;
  log(`### ${result.label}${result.id ? ` (${result.id})` : ''} -> ${STATUS_LABELS[result.status]}`);
  for (const c of result.changes) {
    log(`  ${c.path}\n      - ${show(c.existed ? c.before : undefined)}\n      + ${show(c.after)}${c.source ? `   [${c.source}]` : ''}`);
  }
  for (const c of result.conflicts) {
    log(`  CONFLICT ${c.path}: db has ${show(c.current)}, candidate ${show(c.candidate)} - NOT applied, review${c.note ? ` (${c.note})` : ''}`);
  }
  for (const note of result.notes) log(`  note: ${note}`);
}

function writeBackup({ opts, phase, modelName, results, stamp }) {
  fs.mkdirSync(opts.backupDir, { recursive: true });
  const file = path.join(opts.backupDir, `micronutrient-migration-backup-${stamp}-${phase}.json`);
  const entries = results
    .filter((r) => r.changes.length)
    .map((r) => ({ id: String(r.id), label: r.label, changes: r.changes.map(({ path: p, before, existed, after, unset, source, fallback }) => ({ path: p, before, existed, after, unset: !!unset, source, fallback })) }));
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, phase, model: modelName, createdAt: new Date().toISOString(), entries }, null, 2), { flag: 'wx' });
  return file;
}

// Conditions that must still hold for a change to be written (never-overwrite,
// atomically): the path is still what was read. `{path: null}` matches both
// null and absent. A provenance entry that existed is matched on the fields
// that identify it (it is an object, and its value path carries its own guard).
function guardsFor(change) {
  const { path: p, before } = change;
  if (isMissing(before)) return [{ [p]: null }];
  if (!isProvenancePath(p)) return [{ [p]: before }];
  return ['status', 'confidence', 'researchedAt']
    .filter((key) => !isMissing(before[key]))
    .map((key) => ({ [`${p}.${key}`]: before[key] }));
}

// Prints per-record diffs, (with --execute) writes the backup first and then
// each update, and prints/returns the phase summary.
async function commitPhase({ phase, Model, results, opts, log, stamp, updateOptions = {} }) {
  const summary = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  results.forEach((r) => logResult(r, log));

  if (opts.execute && results.some((r) => r.changes.length)) {
    try {
      const file = writeBackup({ opts, phase, modelName: Model.modelName, results, stamp });
      log(`Backup of old values written: ${file}`);
    } catch (err) {
      log(`!! ${phase}: backup could not be written, NOTHING was written for this phase: ${err.message}`);
      summary.errors = 1;
      return summary;
    }
    for (const r of results) {
      if (!r.changes.length) continue;
      try {
        const update = {};
        const set = r.changes.filter((c) => !c.unset);
        const unset = r.changes.filter((c) => c.unset);
        if (set.length) update.$set = Object.fromEntries(set.map((c) => [c.path, c.after]));
        if (unset.length) update.$unset = Object.fromEntries(unset.map((c) => [c.path, '']));
        const guards = r.changes.flatMap(guardsFor);
        const res = await Model.updateOne({ _id: r.id, ...(guards.length ? { $and: guards } : {}) }, update, updateOptions);
        if (res.matchedCount === 0) {
          // Edited or removed between the read and the write: nothing was written.
          r.status = 'conflict';
          r.notes.push('RACED: changed or removed since it was read, NOT written');
          log(`!! ${r.label}: RACED, the record changed or was removed since it was read; NOT written. Re-run a dry run to see its current state.`);
        } else {
          log(`  -> ${r.label}: written (matched ${res.matchedCount}, modified ${res.modifiedCount})`);
        }
      } catch (err) {
        log(`!! ${r.label}: write failed: ${err.message}`);
        r.status = 'errors';
      }
    }
  }

  results.forEach((r) => { summary[r.status] += 1; });
  log(`\n--- ${phase} summary (${opts.execute ? 'executed' : 'DRY RUN, nothing written'}${opts.rollback ? ', rollback' : ''}) ---`);
  STATUSES.forEach((s) => log(`${STATUS_LABELS[s]}: ${summary[s]}`));
  log('');
  return summary;
}

// ---------------------------------------------------------------- rollback

async function planRollback({ Model, backup, only }) {
  const results = [];
  for (const entry of backup.entries) {
    if (only && entry.id !== only && normalize(entry.label) !== normalize(only)) continue;
    const result = newResult(entry.label, entry.id);
    results.push(result);
    try {
      const doc = await Model.findById(entry.id).lean();
      if (!doc) {
        result.status = 'notFound';
        continue;
      }
      // Same guard for every path: restore only where the current value still
      // equals what the script wrote; anything else was edited since.
      const conflictedPaths = new Set();
      const restore = (c) => {
        const current = getPath(doc, c.path);
        const alreadyBack = c.existed ? sameStored(c.path, current, c.before) : current === undefined;
        if (alreadyBack) return;
        if (!sameStored(c.path, current, c.after)) {
          result.conflicts.push({ path: c.path, current, candidate: c.before, note: 'changed since the migration' });
          conflictedPaths.add(c.path);
          return;
        }
        result.changes.push({ path: c.path, before: current, existed: true, after: c.before, unset: !c.existed });
      };
      entry.changes.filter((x) => !isProvenancePath(x.path)).forEach(restore);
      // A provenance record that still equals what the script wrote is restored
      // even when its value is already back (orphaned provenance), but left
      // with its value when that value is a conflict.
      for (const c of entry.changes.filter((x) => isProvenancePath(x.path))) {
        if (!conflictedPaths.has(`nutritionPer100g.${c.path.split('.')[1]}`)) restore(c);
      }
      result.status = classify(result, true);
    } catch (err) {
      result.status = 'errors';
      result.notes.push(`unexpected error: ${err.message}`);
    }
  }
  return { results };
}

// -------------------------------------------------------------------- run

/**
 * Runs the requested phases against already-connected models. Returns
 * { summaries, hadErrors }. Separated from main() so tests can drive it
 * against an in-memory database.
 */
async function runMigration({ opts, models, manifest, fallback = {}, log = console.log }) {
  const { FoodItem, RecipeVersion, Recipe } = models;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDate = new Date();
  const modelFor = { fooditems: FoodItem, versions: RecipeVersion, recipes: Recipe };
  const updateOptionsFor = { fooditems: {}, versions: { timestamps: false }, recipes: { timestamps: false } };
  const summaries = {};
  log(opts.execute ? '=== EXECUTING ===' : '=== DRY RUN (pass --execute to write) ===');

  if (opts.rollback) {
    const backup = JSON.parse(fs.readFileSync(opts.backupFile, 'utf8'));
    if (backup.phase !== opts.phase) throw new Error(`backup file is for phase "${backup.phase}", not "${opts.phase}"`);
    const { results } = await planRollback({ Model: modelFor[opts.phase], backup, only: opts.only });
    summaries[opts.phase] = await commitPhase({ phase: opts.phase, Model: modelFor[opts.phase], results, opts, log, stamp, updateOptions: updateOptionsFor[opts.phase] });
  } else {
    const phases = opts.phase === 'all' ? PHASES : [opts.phase];
    let projectedFoodItems;
    let projectedV1;
    for (const phase of phases) {
      try {
        let plan;
        if (phase === 'fooditems') {
          plan = await planFoodItems({ FoodItem, manifest, only: opts.only, runDate, includeBulk: opts.includeBulk });
          // Projections only in a dry run; with --execute later phases read what was really written.
          projectedFoodItems = opts.execute ? undefined : plan.projected;
        } else if (phase === 'versions') {
          plan = await planVersions({ RecipeVersion, FoodItem, only: opts.only, projectedFoodItems });
          projectedV1 = opts.execute ? undefined : plan.projectedV1;
        } else {
          plan = await planRecipes({ Recipe, RecipeVersion, only: opts.only, projectedV1, fallback });
        }
        summaries[phase] = await commitPhase({ phase, Model: modelFor[phase], results: plan.results, opts, log, stamp, updateOptions: updateOptionsFor[phase] });
      } catch (err) {
        log(`!! ${phase}: phase failed: ${err.message}`);
        summaries[phase] = { ...Object.fromEntries(STATUSES.map((s) => [s, 0])), errors: 1 };
      }
    }
  }
  const hadErrors = Object.values(summaries).some((s) => s.errors > 0);
  return { summaries, hadErrors };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  // Read and validate the input files before touching the database.
  const needsManifest = !opts.rollback && ['all', 'fooditems'].includes(opts.phase);
  const manifest = needsManifest ? loadManifest() : {};
  const fallback = opts.rollback ? {} : loadFallback(opts.fallbackFile);
  const connectDB = require('../config/database');
  await connectDB();
  try {
    const models = { FoodItem: require('../models/FoodItem'), RecipeVersion: require('../models/RecipeVersion'), Recipe: require('../models/Recipe') };
    const { hadErrors } = await runMigration({ opts, models, manifest, fallback });
    if (hadErrors) process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch(async (err) => {
    console.error('FATAL:', err.message);
    await mongoose.disconnect();
    process.exit(1);
  });
}

module.exports = { parseArgs, loadManifest, loadFallback, runMigration };
