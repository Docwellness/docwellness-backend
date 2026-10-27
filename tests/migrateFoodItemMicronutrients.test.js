/**
 * scripts/migrate-fooditem-micronutrients-prod.js (fill-recipe-micronutrients
 * tasks 6.1-6.4, 6b.5, 6b.6): dry-run default, backup before writes, the
 * fill-only-null / never-overwrite rule for recipes, fallback values and
 * rollback. Real DB semantics via mongodb-memory-server (never Atlas or prod).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { connectTestDb, disconnectTestDb, clearTestDb } = require('./helpers/testDb');

let mongoose;
let models;
let script;
let backupDir;

beforeAll(async () => {
  await connectTestDb();
  mongoose = require('mongoose');
  const { FoodItem, RecipeVersion, Recipe } = require('../models');
  models = { FoodItem, RecipeVersion, Recipe };
  script = require('../scripts/migrate-fooditem-micronutrients-prod');
});

beforeEach(() => {
  backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'micronutrient-backup-'));
});

afterEach(async () => {
  await clearTestDb();
  jest.restoreAllMocks();
  fs.rmSync(backupDir, { recursive: true, force: true });
});

afterAll(async () => {
  await disconnectTestDb();
});

const prov = (status = 'researched') => ({ status, confidence: 'high', method: 'multi-source', sources: [{ name: 'USDA-FDC', ref: 'test', value: 1, basis: 'raw' }] });
const MANIFEST = {
  Chickpeas: { iron: 4.3, sodium: 24, provenance: { iron: prov(), sodium: prov() } },
};

async function seed({ recipe = {} } = {}) {
  const { FoodItem, RecipeVersion } = models;
  const foodItem = await FoodItem.create({
    name: 'Chickpeas',
    normalizedName: 'chickpeas',
    nutritionPer100g: { calories: 364, protein: 19, carbs: 61, fats: 6, fiber: 17 },
    dataSource: 'tier1-seed',
  });
  // Raw insert: Recipe.create would fire the post-save V1 sync hook.
  const recipeId = new mongoose.Types.ObjectId();
  await models.Recipe.collection.insertOne({
    _id: recipeId,
    dieticianId: new mongoose.Types.ObjectId(),
    name: 'Chana Chaat',
    nutrition: { calories: 180 },
    nutritionPerServing: { calories: 180 },
    ...recipe,
  });
  const version = await RecipeVersion.create({
    name: 'Chana Chaat',
    parentRecipeId: recipeId,
    versionNumber: 1,
    ingredients: [{ foodItemId: foodItem._id, rawQuantity: 200, unit: 'g' }],
    nutritionPerServing: { calories: 728, protein: 38, carbs: 122, fats: 12, fiber: 34 },
  });
  return { foodItem, recipeId, version };
}

const MACROS = ['calories', 'protein', 'carbs', 'fats', 'fiber'];
// What the versions phase must never touch: the frozen ingredients and macros.
const frozenPart = (v) => JSON.stringify({ ingredients: v.ingredients, macros: MACROS.map((m) => v.nutritionPerServing[m]) });
const backupFor = (phase) => path.join(backupDir, fs.readdirSync(backupDir).find((f) => f.endsWith(`-${phase}.json`)));

// --yes-all lets the default (all-phase) --execute runs through parseArgs; its guard has its own tests.
function run(args = [], extra = {}) {
  const lines = [];
  const opts = script.parseArgs([`--backup-dir=${backupDir}`, '--yes-all', ...args]);
  return script
    .runMigration({ opts, models, manifest: MANIFEST, log: (line) => lines.push(line), ...extra })
    .then((result) => ({ ...result, output: lines.join('\n') }));
}

describe('migrate-fooditem-micronutrients-prod', () => {
  test('is a dry run by default: reports the diffs, writes no data and no backup', async () => {
    const { foodItem, recipeId, version } = await seed();
    expect(script.parseArgs([]).execute).toBe(false);

    const { summaries, output } = await run();

    // Later phases see the earlier phases' projected values even in a dry run.
    expect(summaries.fooditems.updated).toBe(1);
    expect(summaries.versions.updated).toBe(1);
    expect(summaries.recipes.updated).toBe(1);
    expect(output).toContain('DRY RUN');
    expect(fs.readdirSync(backupDir)).toEqual([]);

    const food = await models.FoodItem.findById(foodItem._id).lean();
    expect(food.nutritionPer100g.iron).toBeNull();
    expect(food.micronutrientProvenance).toBeUndefined();
    const v = await models.RecipeVersion.findById(version._id).lean();
    expect(v.nutritionPerServing.iron).toBeNull();
    const r = await models.Recipe.findById(recipeId).lean();
    expect(r.nutrition.iron).toBeUndefined();
  });

  test('--execute writes a backup of the old values before the first write, then fills every phase', async () => {
    const { foodItem, recipeId, version } = await seed();
    const versionBefore = await models.RecipeVersion.findById(version._id).lean();
    const realUpdateOne = models.FoodItem.updateOne.bind(models.FoodItem);
    let backupExistedAtFirstWrite;
    jest.spyOn(models.FoodItem, 'updateOne').mockImplementation((...args) => {
      backupExistedAtFirstWrite = fs.readdirSync(backupDir).length > 0;
      return realUpdateOne(...args);
    });

    const { summaries, hadErrors } = await run(['--execute']);

    expect(hadErrors).toBe(false);
    expect(backupExistedAtFirstWrite).toBe(true);
    const files = fs.readdirSync(backupDir).sort();
    expect(files).toHaveLength(3);
    const foodBackup = JSON.parse(fs.readFileSync(path.join(backupDir, files.find((f) => f.endsWith('-fooditems.json'))), 'utf8'));
    const ironChange = foodBackup.entries[0].changes.find((c) => c.path === 'nutritionPer100g.iron');
    expect(ironChange).toMatchObject({ before: null, existed: true, after: 4.3 });

    expect(summaries.fooditems.updated).toBe(1);
    const food = await models.FoodItem.findById(foodItem._id).lean();
    expect(food.nutritionPer100g.iron).toBe(4.3);
    expect(food.micronutrientProvenance.iron.status).toBe('researched');

    // 200g of chickpeas: 2 x 4.3 mg iron, 2 x 24 mg sodium.
    const v = await models.RecipeVersion.findById(version._id).lean();
    expect(v.nutritionPerServing.iron).toBeCloseTo(8.6);
    expect(v.nutritionPerServing.sodium).toBeCloseTo(48);
    expect(v.nutritionPerServing.calories).toBe(728);
    expect(v.versionNumber).toBe(1);
    expect(v.updatedAt).toEqual(version.updatedAt);
    expect(frozenPart(v)).toBe(frozenPart(versionBefore));
    expect(v.micronutrientsIncomplete).toContain('calcium');
    expect(await models.RecipeVersion.countDocuments({ parentRecipeId: recipeId })).toBe(1);

    const r = await models.Recipe.findById(recipeId).lean();
    expect(r.nutrition.iron).toBeCloseTo(8.6);
    expect(r.nutritionPerServing.sodium).toBeCloseTo(48);
  });

  test('is idempotent: a second --execute reports only already-correct no-ops and writes no backup', async () => {
    await seed();
    await run(['--execute']);
    const backupsAfterFirstRun = fs.readdirSync(backupDir).length;

    const { summaries } = await run(['--execute']);

    for (const phase of ['fooditems', 'versions', 'recipes']) {
      expect(summaries[phase]).toMatchObject({ updated: 0, alreadyCorrect: 1, conflict: 0, errors: 0 });
    }
    expect(fs.readdirSync(backupDir)).toHaveLength(backupsAfterFirstRun);
  });

  test('never overwrites a differing non-null FoodItem value (conflict) but still fills its null fields', async () => {
    const { foodItem } = await seed();
    await models.FoodItem.updateOne({ _id: foodItem._id }, { $set: { 'nutritionPer100g.iron': 9.9 } });

    const { summaries, output } = await run(['--execute', '--phase=fooditems']);

    expect(summaries.fooditems.conflict).toBe(1);
    expect(output).toContain('CONFLICT nutritionPer100g.iron');
    const food = await models.FoodItem.findById(foodItem._id).lean();
    expect(food.nutritionPer100g.iron).toBe(9.9);
    expect(food.nutritionPer100g.sodium).toBe(24);
  });

  test('recipes with a stored value (verified or not) get only their null nutrients filled; differences are listed, not applied', async () => {
    const { recipeId } = await seed({
      recipe: {
        isVerified: true,
        nutrition: { calories: 180, iron: 3 },
        nutritionPerServing: { calories: 180, iron: 3, sodium: 0 },
      },
    });

    const { summaries, output } = await run(['--execute']);

    expect(summaries.recipes.conflict).toBe(1);
    expect(output).toContain('[verified: true]');
    expect(output).toContain('CONFLICT nutrition.iron: db has 3, candidate 8.6');
    expect(output).toContain('stored 0 looks implausible');
    const r = await models.Recipe.findById(recipeId).lean();
    expect(r.nutrition.iron).toBe(3);
    expect(r.nutritionPerServing.iron).toBe(3);
    expect(r.nutritionPerServing.sodium).toBe(0);
    // A nutrient the recipe had no value for is still filled.
    expect(r.nutrition.sodium).toBeCloseTo(48);
  });

  test('applies a reviewed fallback value to a recipe whose V1 has none, in the recipes phase only', async () => {
    const { recipeId, version } = await seed();
    await models.RecipeVersion.updateOne({ _id: version._id }, { $set: { ingredients: [] } });
    const fallback = { [String(recipeId)]: { iron: { value: 2.5, confidence: 'low', method: 'estimated' } } };

    const { summaries, output } = await run(['--execute'], { fallback });

    expect(summaries.recipes.updated).toBe(1);
    expect(output).toContain('fallback (estimated, confidence low)');
    const r = await models.Recipe.findById(recipeId).lean();
    expect(r.nutrition.iron).toBe(2.5);
    const v = await models.RecipeVersion.findById(version._id).lean();
    expect(v.nutritionPerServing.iron).toBeNull();

    // The backup keeps the estimate identifiable.
    const ironChange = JSON.parse(fs.readFileSync(backupFor('recipes'), 'utf8')).entries[0].changes.find((c) => c.path === 'nutrition.iron');
    expect(ironChange).toMatchObject({ source: 'fallback (estimated, confidence low)', fallback: { method: 'estimated', confidence: 'low' } });
  });

  test('--rollback is a dry run by default and, with --execute, restores the backed-up old values', async () => {
    const { foodItem } = await seed();
    await run(['--execute', '--phase=fooditems']);
    const backupFile = path.join(backupDir, fs.readdirSync(backupDir)[0]);

    const dry = await run(['--rollback', '--phase=fooditems', `--backup=${backupFile}`]);
    expect(dry.summaries.fooditems.updated).toBe(1);
    expect((await models.FoodItem.findById(foodItem._id).lean()).nutritionPer100g.iron).toBe(4.3);

    const real = await run(['--rollback', '--phase=fooditems', `--backup=${backupFile}`, '--execute']);
    expect(real.hadErrors).toBe(false);
    const food = await models.FoodItem.findById(foodItem._id).lean();
    expect(food.nutritionPer100g.iron).toBeNull();
    expect(food.micronutrientProvenance.iron).toBeUndefined();
  });

  test('rollback leaves a value changed since the migration alone and reports a conflict', async () => {
    const { foodItem } = await seed();
    await run(['--execute', '--phase=fooditems']);
    const backupFile = path.join(backupDir, fs.readdirSync(backupDir)[0]);
    await models.FoodItem.updateOne({ _id: foodItem._id }, { $set: { 'nutritionPer100g.iron': 5 } });

    const { summaries } = await run(['--rollback', '--phase=fooditems', `--backup=${backupFile}`, '--execute']);

    expect(summaries.fooditems.conflict).toBe(1);
    expect((await models.FoodItem.findById(foodItem._id).lean()).nutritionPer100g.iron).toBe(5);
  });

  test('versions phase never overwrites a differing stored value (conflict) but fills the others, leaving ingredients and macros untouched', async () => {
    const { version } = await seed();
    await models.RecipeVersion.updateOne({ _id: version._id }, { $set: { 'nutritionPerServing.iron': 3 } });
    const before = await models.RecipeVersion.findById(version._id).lean();

    const { summaries, output } = await run(['--execute']);

    expect(summaries.versions.conflict).toBe(1);
    expect(output).toContain('CONFLICT nutritionPerServing.iron: db has 3, candidate 8.6');
    const v = await models.RecipeVersion.findById(version._id).lean();
    expect(v.nutritionPerServing.iron).toBe(3);
    expect(v.nutritionPerServing.sodium).toBeCloseTo(48);
    expect(frozenPart(v)).toBe(frozenPart(before));
  });

  describe('--phase=all --execute passes downstream only what was written', () => {
    test('a failed fooditems backup writes nothing to fooditems, versions or recipes', async () => {
      const { foodItem, recipeId, version } = await seed();
      const realWrite = fs.writeFileSync;
      jest.spyOn(fs, 'writeFileSync').mockImplementation((file, ...rest) => {
        if (String(file).endsWith('-fooditems.json')) throw new Error('disk full');
        return realWrite(file, ...rest);
      });

      const { summaries, hadErrors } = await run(['--execute']);

      expect(hadErrors).toBe(true);
      expect(summaries.fooditems.errors).toBe(1);
      expect((await models.FoodItem.findById(foodItem._id).lean()).nutritionPer100g.iron).toBeNull();
      const v = await models.RecipeVersion.findById(version._id).lean();
      expect(v.nutritionPerServing.iron).toBeNull();
      expect(v.nutritionPerServing.sodium).toBeNull();
      const r = await models.Recipe.findById(recipeId).lean();
      expect(r.nutrition.iron).toBeUndefined();
      expect(r.nutritionPerServing.sodium).toBeUndefined();
    });

    test('a failed fooditem record write does not leak that record\'s value into versions or recipes', async () => {
      const { foodItem, recipeId, version } = await seed();
      jest.spyOn(models.FoodItem, 'updateOne').mockRejectedValue(new Error('write refused'));

      const { summaries, hadErrors, output } = await run(['--execute']);

      expect(hadErrors).toBe(true);
      expect(summaries.fooditems.errors).toBe(1);
      expect(output).toContain('write failed: write refused');
      expect((await models.FoodItem.findById(foodItem._id).lean()).nutritionPer100g.iron).toBeNull();
      expect((await models.RecipeVersion.findById(version._id).lean()).nutritionPerServing.iron).toBeNull();
      expect((await models.Recipe.findById(recipeId).lean()).nutrition.iron).toBeUndefined();
    });
  });

  describe('rollback of the other phases and of provenance', () => {
    test('versions phase: restores the micronutrient values and leaves ingredients and macros alone', async () => {
      const { version } = await seed();
      await run(['--execute']);
      const filled = await models.RecipeVersion.findById(version._id).lean();
      expect(filled.nutritionPerServing.iron).toBeCloseTo(8.6);

      const { summaries, hadErrors } = await run(['--rollback', '--phase=versions', `--backup=${backupFor('versions')}`, '--execute']);

      expect(hadErrors).toBe(false);
      expect(summaries.versions.updated).toBe(1);
      const v = await models.RecipeVersion.findById(version._id).lean();
      expect(v.nutritionPerServing.iron).toBeNull();
      expect(v.nutritionPerServing.sodium).toBeNull();
      expect(frozenPart(v)).toBe(frozenPart(filled));
    });

    test('recipes phase: unsets a path that did not exist before and keeps the rest of the recipe', async () => {
      const { recipeId } = await seed();
      await run(['--execute']);
      expect((await models.Recipe.findById(recipeId).lean()).nutrition.iron).toBeCloseTo(8.6);

      const { summaries, hadErrors } = await run(['--rollback', '--phase=recipes', `--backup=${backupFor('recipes')}`, '--execute']);

      expect(hadErrors).toBe(false);
      expect(summaries.recipes.updated).toBe(1);
      const r = await models.Recipe.findById(recipeId).lean();
      expect(r.nutrition).toEqual({ calories: 180 });
      expect(r.nutritionPerServing).toEqual({ calories: 180 });
    });

    test('a provenance entry edited since the migration is a conflict, not overwritten or unset', async () => {
      const { foodItem } = await seed();
      await run(['--execute', '--phase=fooditems']);
      const backupFile = backupFor('fooditems');
      await models.FoodItem.updateOne({ _id: foodItem._id }, { $set: { 'micronutrientProvenance.iron.confidence': 'low' } });

      const { summaries, output } = await run(['--rollback', '--phase=fooditems', `--backup=${backupFile}`, '--execute']);

      expect(summaries.fooditems.conflict).toBe(1);
      expect(output).toContain('CONFLICT micronutrientProvenance.iron');
      const food = await models.FoodItem.findById(foodItem._id).lean();
      expect(food.micronutrientProvenance.iron.confidence).toBe('low');
      // The untouched sodium entry and both values are still restored.
      expect(food.micronutrientProvenance.sodium).toBeUndefined();
      expect(food.nutritionPer100g.iron).toBeNull();
    });

    test('orphaned provenance (value already back to the old one) that still equals what the script wrote is unset', async () => {
      const { foodItem } = await seed();
      await run(['--execute', '--phase=fooditems']);
      await models.FoodItem.updateOne({ _id: foodItem._id }, { $set: { 'nutritionPer100g.iron': null } });

      const { summaries } = await run(['--rollback', '--phase=fooditems', `--backup=${backupFor('fooditems')}`, '--execute']);

      expect(summaries.fooditems.conflict).toBe(0);
      const food = await models.FoodItem.findById(foodItem._id).lean();
      expect(food.micronutrientProvenance?.iron).toBeUndefined();
      expect(food.nutritionPer100g.sodium).toBeNull();
    });
  });

  describe('zero values', () => {
    const ZERO = (status, extra = {}) => ({ Chickpeas: { iron: 0, sodium: 24, provenance: { iron: { ...prov(status), ...extra }, sodium: prov() } } });

    test('a manifest 0 without verified-zero provenance is skipped with a note', async () => {
      const { foodItem } = await seed();

      const { output } = await run(['--execute', '--phase=fooditems'], { manifest: ZERO('researched') });

      expect(output).toContain('iron: value 0 without verified-zero provenance, skipped');
      const food = await models.FoodItem.findById(foodItem._id).lean();
      expect(food.nutritionPer100g.iron).toBeNull();
      expect(food.micronutrientProvenance.iron).toBeUndefined();
      expect(food.nutritionPer100g.sodium).toBe(24);
    });

    test('a manifest 0 with verified-zero provenance is written', async () => {
      const { foodItem } = await seed();

      await run(['--execute', '--phase=fooditems'], { manifest: ZERO('verified-zero') });

      const food = await models.FoodItem.findById(foodItem._id).lean();
      expect(food.nutritionPer100g.iron).toBe(0);
      expect(food.micronutrientProvenance.iron.status).toBe('verified-zero');
    });

    test('a _bulk 0 is skipped under --include-bulk unless the provenance says verified-zero', async () => {
      const { foodItem } = await seed();
      const manifest = { Chickpeas: { iron: 0, provenance: { _bulk: { status: 'researched', confidence: 'low', method: 'estimated' } } } };

      const { output } = await run(['--execute', '--phase=fooditems', '--include-bulk'], { manifest });

      expect(output).toContain('iron: value 0 without verified-zero provenance, skipped');
      expect((await models.FoodItem.findById(foodItem._id).lean()).nutritionPer100g.iron).toBeNull();
    });

    describe('fallback file', () => {
      const load = (content) => {
        const file = path.join(backupDir, 'fallback.json');
        fs.writeFileSync(file, JSON.stringify(content));
        return () => script.loadFallback(file);
      };

      test('rejects a 0 without the reviewed verifiedZero marker and accepts it with', () => {
        expect(load({ r1: { iron: { value: 0, confidence: 'low', method: 'estimated' } } })).toThrow('"verifiedZero": true');
        expect(load({ r1: { iron: { value: 0, verifiedZero: true } } })()).toEqual({ r1: { iron: { value: 0, verifiedZero: true } } });
      });

      test('names a nested entry that is not an object instead of throwing a TypeError', () => {
        expect(load({ r1: { iron: 2.5 } })).toThrow('fallback r1.iron: must be an object');
        expect(load({ r1: null })).toThrow('fallback r1: must be an object');
      });
    });
  });

  test('reports not-found for a manifest ingredient missing from the database and exits clean', async () => {
    await seed();
    const { summaries, hadErrors } = await run(['--phase=fooditems'], { manifest: { ...MANIFEST, 'Dragon Fruit': { iron: 1, provenance: { iron: prov() } } } });

    expect(summaries.fooditems.notFound).toBe(1);
    expect(hadErrors).toBe(false);
  });

  describe('unverified _bulk provenance', () => {
    const bulkProv = { status: 'researched', confidence: 'low', method: 'estimated', note: 'not independently web-verified' };
    const BULK_ONLY = { Chickpeas: { iron: 4.3, sodium: 24, provenance: { _bulk: bulkProv } } };
    const MIXED = { Chickpeas: { iron: 4.3, sodium: 24, provenance: { sodium: prov(), _bulk: bulkProv } } };

    test('--include-bulk is off by default and switched on by the flag', () => {
      expect(script.parseArgs([]).includeBulk).toBe(false);
      expect(script.parseArgs(['--include-bulk']).includeBulk).toBe(true);
    });

    test('skips a field that has only the _bulk provenance by default: no value, no provenance, noted', async () => {
      const { foodItem } = await seed();

      const { summaries, output } = await run(['--execute', '--phase=fooditems'], { manifest: BULK_ONLY });

      expect(summaries.fooditems).toMatchObject({ skippedNullData: 1, updated: 0 });
      expect(output).toContain('iron: unverified _bulk provenance, skipped (pass --include-bulk to apply)');
      const food = await models.FoodItem.findById(foodItem._id).lean();
      expect(food.nutritionPer100g.iron).toBeNull();
      expect(food.micronutrientProvenance).toBeUndefined();
      expect(fs.readdirSync(backupDir)).toEqual([]);
    });

    test('applies the _bulk fields as researched when --include-bulk is passed', async () => {
      const { foodItem } = await seed();

      const { summaries } = await run(['--execute', '--phase=fooditems', '--include-bulk'], { manifest: BULK_ONLY });

      expect(summaries.fooditems.updated).toBe(1);
      const food = await models.FoodItem.findById(foodItem._id).lean();
      expect(food.nutritionPer100g.iron).toBe(4.3);
      expect(food.micronutrientProvenance.iron).toMatchObject({ status: 'researched', confidence: 'low' });
    });

    test('records a _bulk-only value as low confidence even when the manifest says medium', async () => {
      const { foodItem } = await seed();
      const manifest = { Chickpeas: { iron: 4.3, provenance: { _bulk: { ...bulkProv, confidence: 'medium' } } } };

      await run(['--execute', '--phase=fooditems', '--include-bulk'], { manifest });

      expect((await models.FoodItem.findById(foodItem._id).lean()).micronutrientProvenance.iron.confidence).toBe('low');
    });

    test('still applies a field with its own provenance while skipping the _bulk one on the same entry', async () => {
      const { foodItem } = await seed();

      const { summaries } = await run(['--execute', '--phase=fooditems'], { manifest: MIXED });

      expect(summaries.fooditems.updated).toBe(1);
      const food = await models.FoodItem.findById(foodItem._id).lean();
      expect(food.nutritionPer100g.sodium).toBe(24);
      expect(food.micronutrientProvenance.sodium.confidence).toBe('high');
      expect(food.nutritionPer100g.iron).toBeNull();
      expect(food.micronutrientProvenance.iron).toBeUndefined();
    });

    test('a dry run does not leak skipped _bulk values into the versions or recipes projections', async () => {
      await seed();

      const { summaries, output } = await run([], { manifest: MIXED });

      expect(summaries.versions.updated).toBe(1);
      expect(output).toContain('nutritionPerServing.sodium');
      expect(output).not.toContain('nutritionPerServing.iron');
      expect(output).not.toContain('nutrition.iron');
    });

    test('a dry run with only _bulk fields projects nothing into the versions or recipes phases', async () => {
      await seed();

      const { summaries } = await run([], { manifest: BULK_ONLY });

      expect(summaries.fooditems.skippedNullData).toBe(1);
      expect(summaries.versions).toMatchObject({ updated: 0, skippedNullData: 1 });
      expect(summaries.recipes).toMatchObject({ updated: 0, skippedNullData: 1 });
    });
  });

  describe('--phase=all --execute needs --yes-all', () => {
    const parse = (...args) => () => script.parseArgs(args);

    test('is refused for the default phase and for an explicit --phase=all, naming the way out', () => {
      expect(parse('--execute')).toThrow('--yes-all');
      expect(parse('--execute', '--phase=all')).toThrow('one at a time');
    });

    test('is allowed with --yes-all, and a dry run or a single-phase --execute never needs it', () => {
      expect(script.parseArgs(['--execute', '--yes-all']).yesAll).toBe(true);
      expect(parse()).not.toThrow();
      expect(parse('--phase=all')).not.toThrow();
      expect(parse('--execute', '--phase=versions')).not.toThrow();
    });
  });

  describe('manifest validation (before any database connection)', () => {
    const load = (text) => {
      const file = path.join(backupDir, 'manifest.json');
      fs.writeFileSync(file, text);
      return () => script.loadManifest(file);
    };

    test('loads the real manifest and accepts null for a nutrient not researched', () => {
      expect(Object.keys(script.loadManifest()).length).toBeGreaterThan(100);
      expect(load('{"Salt":{"iron":null,"sodium":38758,"provenance":{"sodium":{"status":"researched"}},"note":"x"}}')()).toHaveProperty('Salt');
    });

    test('rejects a string, a non-finite number, a negative number and an unknown nutrient, naming the entry', () => {
      expect(load('{"Salt":{"sodium":"24"}}')).toThrow('manifest Salt.sodium: value must be a finite number >= 0');
      expect(load('{"Salt":{"sodium":1e999}}')).toThrow('manifest Salt.sodium');
      expect(load('{"Salt":{"sodium":-1}}')).toThrow('manifest Salt.sodium');
      expect(load('{"Salt":{"sodiumm":3}}')).toThrow('manifest Salt: unknown nutrient "sodiumm"');
      expect(load('{"Salt":{"sodium":3,"provenance":{"sodiumm":{}}}}')).toThrow('manifest Salt.provenance: unknown nutrient "sodiumm"');
    });
  });

  describe('atomic never-overwrite: a record edited between the read and the write is not written', () => {
    // Applies `mutate` straight to the collection just before the real write, as a concurrent editor would.
    const editBeforeWrite = (Model, mutate) => {
      const realUpdateOne = Model.updateOne.bind(Model);
      jest.spyOn(Model, 'updateOne').mockImplementation(async (filter, ...rest) => {
        await Model.collection.updateOne({ _id: new mongoose.Types.ObjectId(String(filter._id)) }, mutate);
        return realUpdateOne(filter, ...rest);
      });
    };

    test('fooditems: the concurrent value survives, the whole record is reported as raced (conflict)', async () => {
      const { foodItem } = await seed();
      editBeforeWrite(models.FoodItem, { $set: { 'nutritionPer100g.iron': 9.9 } });

      const { summaries, hadErrors, output } = await run(['--execute', '--phase=fooditems']);

      expect(summaries.fooditems).toMatchObject({ conflict: 1, updated: 0, errors: 0 });
      expect(hadErrors).toBe(false);
      expect(output).toContain('RACED');
      const food = await models.FoodItem.findById(foodItem._id).lean();
      expect(food.nutritionPer100g.iron).toBe(9.9);
      expect(food.nutritionPer100g.sodium).toBeNull();
      expect(food.micronutrientProvenance).toBeUndefined();
    });

    test('versions: the concurrent value survives and nothing else of the record is written', async () => {
      const { version } = await seed();
      await run(['--execute', '--phase=fooditems']);
      editBeforeWrite(models.RecipeVersion, { $set: { 'nutritionPerServing.sodium': 1 } });

      const { summaries, output } = await run(['--execute', '--phase=versions']);

      expect(summaries.versions).toMatchObject({ conflict: 1, updated: 0 });
      expect(output).toContain('RACED');
      const v = await models.RecipeVersion.findById(version._id).lean();
      expect(v.nutritionPerServing.sodium).toBe(1);
      expect(v.nutritionPerServing.iron).toBeNull();
    });

    test('versions: a legacy version without the micronutrientsIncomplete field is filled, not reported as raced', async () => {
      const { version } = await seed();
      await run(['--execute', '--phase=fooditems']);
      // Raw unset: Mongoose would otherwise default the field to [].
      await models.RecipeVersion.collection.updateOne({ _id: version._id }, { $unset: { micronutrientsIncomplete: '' } });
      expect(await models.RecipeVersion.collection.findOne({ _id: version._id, micronutrientsIncomplete: { $exists: false } })).not.toBeNull();

      const { summaries, output } = await run(['--execute', '--phase=versions']);

      expect(summaries.versions).toMatchObject({ updated: 1, conflict: 0, errors: 0 });
      expect(output).not.toContain('RACED');
      const v = await models.RecipeVersion.findById(version._id).lean();
      expect(v.nutritionPerServing.iron).toBeCloseTo(8.6);
      expect(v.micronutrientsIncomplete).toContain('calcium');
    });

    test('versions: a concurrent change to only micronutrientsIncomplete blocks the write', async () => {
      const { version } = await seed();
      await run(['--execute', '--phase=fooditems']);
      editBeforeWrite(models.RecipeVersion, { $set: { micronutrientsIncomplete: ['vitaminC'] } });

      const { summaries, output } = await run(['--execute', '--phase=versions']);

      expect(summaries.versions).toMatchObject({ conflict: 1, updated: 0 });
      expect(output).toContain('RACED');
      const v = await models.RecipeVersion.findById(version._id).lean();
      expect(v.micronutrientsIncomplete).toEqual(['vitaminC']);
      expect(v.nutritionPerServing.iron).toBeNull();
      expect(v.nutritionPerServing.sodium).toBeNull();
    });

    describe('fooditems: a concurrent change to only a pre-existing provenance entry blocks the write', () => {
      const researchedAt = new Date('2026-01-15T00:00:00.000Z');
      const concurrent = {
        status: ['status', 'verified-zero'],
        confidence: ['confidence', 'medium'],
        researchedAt: ['researchedAt', new Date('2026-02-01T00:00:00.000Z')],
      };

      test.each(Object.keys(concurrent))('%s', async (key) => {
        const { foodItem } = await seed();
        await models.FoodItem.updateOne(
          { _id: foodItem._id },
          { $set: { 'micronutrientProvenance.iron': { status: 'unknown', confidence: 'low', method: 'single-source', note: 'placeholder', researchedAt } } },
        );
        const [field, value] = concurrent[key];
        editBeforeWrite(models.FoodItem, { $set: { [`micronutrientProvenance.iron.${field}`]: value } });

        const { summaries, output } = await run(['--execute', '--phase=fooditems']);

        expect(summaries.fooditems).toMatchObject({ conflict: 1, updated: 0 });
        expect(output).toContain('RACED');
        const food = await models.FoodItem.findById(foodItem._id).lean();
        expect(food.micronutrientProvenance.iron[field]).toEqual(value);
        expect(food.nutritionPer100g.iron).toBeNull();
        expect(food.nutritionPer100g.sodium).toBeNull();
        expect(food.micronutrientProvenance.sodium).toBeUndefined();
      });
    });

    test('recipes: the concurrent value survives and nothing else of the record is written', async () => {
      const { recipeId } = await seed();
      await run(['--execute', '--phase=fooditems']);
      await run(['--execute', '--phase=versions']);
      editBeforeWrite(models.Recipe, { $set: { 'nutrition.iron': 1 } });

      const { summaries, output } = await run(['--execute', '--phase=recipes']);

      expect(summaries.recipes).toMatchObject({ conflict: 1, updated: 0 });
      expect(output).toContain('RACED');
      const r = await models.Recipe.findById(recipeId).lean();
      expect(r.nutrition.iron).toBe(1);
      expect(r.nutritionPerServing.sodium).toBeUndefined();
    });

    test('rollback: a value edited after the rollback was planned is left alone and reported', async () => {
      const { foodItem } = await seed();
      await run(['--execute', '--phase=fooditems']);
      editBeforeWrite(models.FoodItem, { $set: { 'nutritionPer100g.iron': 5 } });

      const { summaries, output } = await run(['--rollback', '--phase=fooditems', `--backup=${backupFor('fooditems')}`, '--execute']);

      expect(summaries.fooditems.conflict).toBe(1);
      expect(output).toContain('RACED');
      const food = await models.FoodItem.findById(foodItem._id).lean();
      expect(food.nutritionPer100g.iron).toBe(5);
      expect(food.micronutrientProvenance.iron.status).toBe('researched');
    });
  });

  describe('rollback restores what existed before the migration', () => {
    test('a provenance entry that existed before is restored with researchedAt as a Date', async () => {
      const researchedAt = new Date('2026-01-15T00:00:00.000Z');
      const { foodItem } = await seed();
      await models.FoodItem.updateOne(
        { _id: foodItem._id },
        { $set: { 'micronutrientProvenance.iron': { status: 'unknown', confidence: 'low', method: 'single-source', note: 'placeholder', researchedAt } } },
      );
      await run(['--execute', '--phase=fooditems']);
      expect((await models.FoodItem.findById(foodItem._id).lean()).micronutrientProvenance.iron.status).toBe('researched');
      const ironProvenance = JSON.parse(fs.readFileSync(backupFor('fooditems'), 'utf8')).entries[0].changes.find((c) => c.path === 'micronutrientProvenance.iron');
      expect(ironProvenance.existed).toBe(true);

      const { summaries } = await run(['--rollback', '--phase=fooditems', `--backup=${backupFor('fooditems')}`, '--execute']);

      expect(summaries.fooditems.conflict).toBe(0);
      const restored = (await models.FoodItem.findById(foodItem._id).lean()).micronutrientProvenance.iron;
      expect(restored).toMatchObject({ status: 'unknown', note: 'placeholder' });
      expect(restored.researchedAt).toBeInstanceOf(Date);
      expect(restored.researchedAt.toISOString()).toBe(researchedAt.toISOString());
    });

    test('a versions rollback also restores micronutrientsIncomplete', async () => {
      const { version } = await seed();
      const before = await models.RecipeVersion.findById(version._id).lean();
      await run(['--execute']);
      expect((await models.RecipeVersion.findById(version._id).lean()).micronutrientsIncomplete).toContain('calcium');

      await run(['--rollback', '--phase=versions', `--backup=${backupFor('versions')}`, '--execute']);

      expect((await models.RecipeVersion.findById(version._id).lean()).micronutrientsIncomplete).toEqual(before.micronutrientsIncomplete);
    });
  });

  test('a _bulk verified-zero value of 0 is written under --include-bulk, with confidence forced to low', async () => {
    const { foodItem } = await seed();
    const manifest = { Chickpeas: { iron: 0, provenance: { _bulk: { status: 'verified-zero', confidence: 'high', method: 'multi-source' } } } };

    await run(['--execute', '--phase=fooditems', '--include-bulk'], { manifest });

    const food = await models.FoodItem.findById(foodItem._id).lean();
    expect(food.nutritionPer100g.iron).toBe(0);
    expect(food.micronutrientProvenance.iron).toMatchObject({ status: 'verified-zero', confidence: 'low' });
  });

  test('a failed backup aborts the phase: nothing is written and an error is reported', async () => {
    const { foodItem } = await seed();
    jest.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw new Error('disk full'); });

    const { summaries, hadErrors } = await run(['--execute', '--phase=fooditems']);

    expect(hadErrors).toBe(true);
    expect(summaries.fooditems.errors).toBe(1);
    expect((await models.FoodItem.findById(foodItem._id).lean()).nutritionPer100g.iron).toBeNull();
  });
});
