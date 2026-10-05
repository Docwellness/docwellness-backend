/**
 * Tests for the review-sheet CSV round trip (utils/layaCsv.js and
 * scripts/laya-eval-import-review-sheet.js). The rows below are tiny inline
 * fixtures exercising parsing and validation - not evaluation data.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const {
  BLIND_COLUMNS,
  SLOT_COLUMNS,
  csvColumns,
  toCsv,
  parseCsv,
  parseCsvObjects,
  sheetToCsvRows,
  csvToDataset,
} = require('../utils/layaCsv');

describe('toCsv / parseCsv', () => {
  it('quotes commas, quotes and newlines, and round-trips them', () => {
    const rows = [
      { id: '1', name: 'Dal, Rice & "Papad"', ingredients: 'toor dal; rice\nghee', cuisine: '' },
      { id: '2', name: 'Plain', ingredients: '', cuisine: 'Indian' },
    ];
    const csv = toCsv(rows, ['id', 'name', 'ingredients', 'cuisine']);
    expect(parseCsvObjects(csv)).toEqual([
      { id: '1', name: 'Dal, Rice & "Papad"', ingredients: 'toor dal; rice\nghee', cuisine: '' },
      { id: '2', name: 'Plain', ingredients: '', cuisine: 'Indian' },
    ]);
  });

  it('tolerates a BOM, CRLF or LF line endings, and trailing blank lines (as spreadsheets save them)', () => {
    const a = parseCsvObjects('﻿id,name\r\n1,A\r\n2,B\r\n\r\n');
    const b = parseCsvObjects('id,name\n1,A\n2,B\n');
    expect(a).toEqual(b);
    expect(a).toHaveLength(2);
  });

  it('pads short rows with empty strings and rejects an unterminated quote', () => {
    expect(parseCsvObjects('id,name,x\n1,A\n')[0]).toEqual({ id: '1', name: 'A', x: '' });
    expect(() => parseCsv('id,name\n1,"oops\n')).toThrow(/unterminated/);
  });
});

describe('the review sheet is blind', () => {
  const sheetRow = {
    id: 'r1',
    input: { recipe: { name: 'Poha', cuisine: 'Indian', category: 'Indian', ingredients: [{ name: 'poha' }, { name: 'peanuts' }] } },
    source: { servingTime: 'Breakfast', slot: 'breakfast' },
    expected: null,
    reviewed_by: null,
  };

  it('has no servingTime or source column by default, one suitable_slots column, and empty reviewer columns', () => {
    expect(BLIND_COLUMNS).toContain('suitable_slots');
    for (const bad of ['servingTime', 'source_slot', 'source_meal_type', 'proposed_meal_type', 'expected_meal_type']) {
      expect(BLIND_COLUMNS).not.toContain(bad);
    }
    expect(csvColumns()).toEqual(BLIND_COLUMNS);

    const [row] = sheetToCsvRows([sheetRow]);
    expect(row).toMatchObject({ id: 'r1', name: 'Poha', ingredients: 'poha; peanuts', suitable_slots: '', expected_protein_level: '', reviewer: '', review_status: '', review_notes: '' });
    const csv = toCsv([row], csvColumns());
    expect(csv).not.toMatch(/breakfast/i); // the existing slot cannot reach the reviewer
  });

  it('only shows the source slot when asked (--with-source), after the recipe columns', () => {
    const cols = csvColumns({ withSource: true });
    expect(cols.slice(cols.indexOf('ingredients') + 1, cols.indexOf('ingredients') + 3)).toEqual(['servingTime', 'source_slot']);
    expect(csvColumns()).not.toContain('servingTime');
    const [row] = sheetToCsvRows([sheetRow], { withSource: true });
    expect(row).toMatchObject({ servingTime: 'Breakfast', source_slot: 'Breakfast' });
  });

  it('can use seven y/n slot columns instead of the single list (--slot-columns)', () => {
    const cols = csvColumns({ slotColumns: true });
    expect(cols).not.toContain('suitable_slots');
    expect(cols.filter((c) => c.startsWith('slot_'))).toEqual(SLOT_COLUMNS);
    expect(SLOT_COLUMNS).toHaveLength(7);
  });
});

describe('csvToDataset (strict)', () => {
  const row = (over) => ({
    id: 'r1', name: 'Poha', cuisine: 'Indian', category: 'Indian',
    ingredients: 'poha; peanuts, roasted; onion',
    suitable_slots: '', expected_protein_level: '', reviewer: '', review_status: '', review_notes: '', ...over,
  });

  it('turns a reviewed row into an example with every slot the recipe suits, in canonical order', () => {
    const { examples, errors, pending } = csvToDataset([
      row({ suitable_slots: ' Brunch ; breakfast ', expected_protein_level: 'MODERATE', reviewer: ' Dr A ', review_status: 'Reviewed', review_notes: ' hard case ' }),
    ]);
    expect(errors).toEqual([]);
    expect(pending).toBe(0);
    expect(examples[0]).toMatchObject({
      id: 'r1',
      expected: { suitable_slots: ['breakfast', 'brunch'], protein_level: 'moderate' },
      reviewed_by: 'dietician',
      reviewer: 'Dr A',
      review_notes: 'hard case',
    });
    // "; " separates ingredients, so a name containing a comma survives intact
    expect(examples[0].input.recipe.ingredients).toEqual([{ name: 'poha' }, { name: 'peanuts, roasted' }, { name: 'onion' }]);
  });

  it('covers drinks and brunch, not just the four main meals', () => {
    const { examples, errors } = csvToDataset([row({ suitable_slots: 'Morning Drink; Night Drink', reviewer: 'x', review_status: 'reviewed' })]);
    expect(errors).toEqual([]);
    expect(examples[0].expected.suitable_slots).toEqual(['morning_drink', 'night_drink']);
  });

  it('NEVER puts servingTime in the dataset input, even if the sheet has that column', () => {
    const { examples } = csvToDataset([
      row({ servingTime: 'Dinner', source_slot: 'Dinner', suitable_slots: 'Lunch', reviewer: 'x', review_status: 'reviewed' }),
    ]);
    expect(Object.keys(examples[0].input.recipe)).toEqual(['name', 'cuisine', 'category', 'ingredients']);
    expect(JSON.stringify(examples[0].input)).not.toMatch(/servingTime|Dinner|dinner/);
    // the source slot is kept as metadata OUTSIDE input, so analysis can still use it
    expect(examples[0].source).toEqual({ slot: 'dinner' });
  });

  it('accepts sheets with no review_status column (reviewer + values = reviewed)', () => {
    const { examples, errors } = csvToDataset([row({ suitable_slots: 'Dinner', reviewer: 'x' })]);
    expect(errors).toEqual([]);
    expect(examples).toHaveLength(1);
  });

  it('accepts a slots-only or a protein-only review', () => {
    const { examples } = csvToDataset([
      row({ id: 'a', suitable_slots: 'Lunch', reviewer: 'x', review_status: 'reviewed' }),
      row({ id: 'b', expected_protein_level: 'high', reviewer: 'x', review_status: 'reviewed' }),
    ]);
    expect(examples[0].expected).toEqual({ suitable_slots: ['lunch'] });
    expect(examples[1].expected).toEqual({ protein_level: 'high' });
  });

  it('records skipped and unsure rows (with notes) without scoring or erroring', () => {
    const r = csvToDataset([
      row({ id: 's', name: 'Green Tea', reviewer: 'Dr A', review_status: 'skipped', review_notes: 'a beverage, not a meal' }),
      row({ id: 'u', name: 'Chutney', reviewer: 'Dr A', review_status: 'unsure' }),
      row({ id: 'p' }), // untouched
    ]);
    expect(r.errors).toEqual([]);
    expect(r.examples).toEqual([]);
    expect(r.skipped).toEqual([{ id: 's', name: 'Green Tea', notes: 'a beverage, not a meal' }]);
    expect(r.unsure).toEqual([{ id: 'u', name: 'Chutney', notes: '' }]);
    expect(r.pending).toBe(1);
  });

  it('refuses half-filled and invalid rows instead of guessing', () => {
    const { examples, errors } = csvToDataset([
      row({ id: 'e1', suitable_slots: 'Lunch' }), // values but no reviewer
      row({ id: 'e2', reviewer: 'x' }), // reviewer but no values and no status
      row({ id: 'e3', reviewer: 'x', suitable_slots: 'Lunch; Teatime' }), // a slot that does not exist
      row({ id: 'e4', reviewer: 'x', suitable_slots: 'Lunch', expected_protein_level: 'medium' }), // not a valid level
      row({ id: '', reviewer: 'x', suitable_slots: 'Lunch' }), // no id
      row({ id: 'e6', review_status: 'reviewed' }), // status reviewed, nobody and nothing
      row({ id: 'e7', reviewer: 'x', review_status: 'maybe' }), // unknown status
      row({ id: 'e8', reviewer: 'x', review_status: 'skipped', suitable_slots: 'Lunch' }), // skipped but values filled
      row({ id: 'e9', review_status: 'unsure' }), // unsure with no reviewer
    ]);
    expect(examples).toEqual([]);
    expect(errors.map((e) => e.id)).toEqual(['e1', 'e2', 'e3', 'e4', '', 'e6', 'e7', 'e8', 'e9']);
    expect(errors[0].message).toMatch(/no reviewer/);
    expect(errors[1].message).toMatch(/no suitable slots.*skipped/);
    expect(errors[2].message).toMatch(/unknown slot\(s\) "Teatime" - use: Morning Drink, Breakfast, Brunch, Lunch, Evening Snack, Dinner, Night Drink/);
    expect(errors[3].message).toMatch(/low, moderate, high/);
    expect(errors[5].message).toMatch(/no reviewer/);
    expect(errors[6].message).toMatch(/must be one of: reviewed, skipped, unsure/);
    expect(errors[7].message).toMatch(/clear them/);
    expect(errors[8].message).toMatch(/needs a reviewer/);
    expect(errors.map((e) => e.line)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]); // header is line 1
  });

  it('flags a duplicate id', () => {
    const { errors } = csvToDataset([
      row({ id: 'd', reviewer: 'x', suitable_slots: 'Lunch' }),
      row({ id: 'd', reviewer: 'x', suitable_slots: 'Dinner' }),
    ]);
    expect(errors).toEqual([{ line: null, id: 'd', message: 'duplicate id in the sheet' }]);
  });
});

describe('csvToDataset with seven y/n slot columns', () => {
  const base = { id: 'r1', name: 'Dal', cuisine: '', category: '', ingredients: 'dal', expected_protein_level: '', reviewer: '', review_status: '', review_notes: '' };
  const slots = (over) => ({ ...Object.fromEntries(SLOT_COLUMNS.map((c) => [c, 'n'])), ...over });

  it('reads y/n per slot (also yes/no/x/1/0)', () => {
    const { examples, errors } = csvToDataset([{ ...base, ...slots({ slot_lunch: 'Y', slot_dinner: 'yes' }), reviewer: 'x', review_status: 'reviewed' }]);
    expect(errors).toEqual([]);
    expect(examples[0].expected.suitable_slots).toEqual(['lunch', 'dinner']);
    const x = csvToDataset([{ ...base, ...slots({ slot_breakfast: 'x', slot_brunch: '1' }), reviewer: 'x', review_status: 'reviewed' }]);
    expect(x.examples[0].expected.suitable_slots).toEqual(['breakfast', 'brunch']);
  });

  it('requires an explicit answer for EVERY slot once any is filled (blank is not "no")', () => {
    const { errors } = csvToDataset([{ ...base, ...slots({ slot_lunch: 'y', slot_night_drink: '' }), reviewer: 'x', review_status: 'reviewed' }]);
    expect(errors[0].message).toMatch(/slot_night_drink is blank - answer y or n for every slot/);
  });

  it('rejects an answer that is not y or n, and treats an untouched row as pending', () => {
    const bad = csvToDataset([{ ...base, ...slots({ slot_lunch: 'maybe' }), reviewer: 'x', review_status: 'reviewed' }]);
    expect(bad.errors[0].message).toMatch(/slot_lunch "maybe" must be y or n/);
    const blank = csvToDataset([{ ...base, ...Object.fromEntries(SLOT_COLUMNS.map((c) => [c, ''])) }]);
    expect(blank).toMatchObject({ errors: [], pending: 1, examples: [] });
  });
});

describe('scripts/laya-eval-import-review-sheet.js', () => {
  let dir;
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-import-')); });
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const run = (args) =>
    new Promise((resolve) => {
      execFile(process.execPath, [path.join(__dirname, '..', 'scripts', 'laya-eval-import-review-sheet.js'), ...args], { cwd: path.join(__dirname, '..') },
        (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
    });

  const sheet = (rows) => toCsv(rows, BLIND_COLUMNS);
  const base = { id: 'r1', name: 'A', cuisine: '', category: '', ingredients: 'x; y', suitable_slots: '', expected_protein_level: '', reviewer: '', review_status: '', review_notes: '' };

  it('writes only reviewed rows, lists skipped/unsure/pending, and the output passes the evaluation runner\'s gate', async () => {
    const csv = path.join(dir, 'a.csv');
    const out = path.join(dir, 'recipe_classification.json');
    fs.writeFileSync(csv, sheet([
      { ...base, id: 'r1', suitable_slots: 'Lunch; Dinner', expected_protein_level: 'high', reviewer: 'Dr A', review_status: 'reviewed' },
      { ...base, id: 'r2' }, // pending
      { ...base, id: 'r3', name: 'Green Tea', reviewer: 'Dr A', review_status: 'skipped', review_notes: 'beverage' },
      { ...base, id: 'r4', name: 'Chutney', reviewer: 'Dr A', review_status: 'unsure' },
    ]));
    const r = await run([`--in=${csv}`, `--out=${out}`]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Imported 1 reviewed row/);
    expect(r.stdout).toMatch(/1 marked skipped, 1 marked unsure, 1 still pending/);
    expect(r.stdout).toMatch(/skipped: Green Tea - beverage/);
    expect(r.stdout).toMatch(/needs a second opinion: Chutney/);
    expect(r.stdout).toMatch(/suitable per slot.*lunch: 1.*dinner: 1/);
    const data = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(data).toHaveLength(1);
    expect(data[0].expected.suitable_slots).toEqual(['lunch', 'dinner']);
    const { isReviewed } = require('../utils/layaEval');
    expect(isReviewed(data[0])).toBe(true);
  });

  it('merges by id on a later import (a re-review replaces the earlier row) unless --replace', async () => {
    const out = path.join(dir, 'merge.json');
    const first = path.join(dir, 'm1.csv');
    const second = path.join(dir, 'm2.csv');
    const rv = { reviewer: 'x', review_status: 'reviewed' };
    fs.writeFileSync(first, sheet([{ ...base, id: 'a', suitable_slots: 'Lunch', ...rv }, { ...base, id: 'b', suitable_slots: 'Dinner', ...rv }]));
    fs.writeFileSync(second, sheet([{ ...base, id: 'b', suitable_slots: 'Evening Snack', ...rv }, { ...base, id: 'c', suitable_slots: 'Breakfast', ...rv }]));
    await run([`--in=${first}`, `--out=${out}`]);
    await run([`--in=${second}`, `--out=${out}`]);
    const merged = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(merged.map((e) => `${e.id}:${e.expected.suitable_slots}`).sort()).toEqual(['a:lunch', 'b:evening_snack', 'c:breakfast']);

    await run([`--in=${second}`, `--out=${out}`, '--replace']);
    expect(JSON.parse(fs.readFileSync(out, 'utf8')).map((e) => e.id).sort()).toEqual(['b', 'c']);
  });

  it('strips servingTime from a non-blind sheet when importing it', async () => {
    const csv = path.join(dir, 'old.csv');
    const out = path.join(dir, 'old.json');
    fs.writeFileSync(csv, toCsv([{ ...base, id: 'o1', servingTime: 'Dinner', source_slot: 'Dinner', suitable_slots: 'Dinner', reviewer: 'x' }],
      ['id', 'name', 'cuisine', 'category', 'servingTime', 'source_slot', 'ingredients', 'suitable_slots', 'expected_protein_level', 'reviewer']));
    const r = await run([`--in=${csv}`, `--out=${out}`]);
    expect(r.code).toBe(0);
    const [ex] = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(JSON.stringify(ex.input)).not.toMatch(/servingTime|Dinner/);
    expect(ex.source).toEqual({ slot: 'dinner' });
  });

  it('writes NOTHING and exits non-zero when any row has a problem', async () => {
    const csv = path.join(dir, 'bad.csv');
    const out = path.join(dir, 'never.json');
    fs.writeFileSync(csv, sheet([
      { ...base, id: 'ok', suitable_slots: 'Lunch', reviewer: 'x', review_status: 'reviewed' },
      { ...base, id: 'bad', suitable_slots: 'Teatime', reviewer: 'x', review_status: 'reviewed' },
    ]));
    const r = await run([`--in=${csv}`, `--out=${out}`]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Nothing was written/);
    expect(r.stderr).toMatch(/line 3 \(id bad\)/);
    expect(fs.existsSync(out)).toBe(false);
  });

  it('requires --in', async () => {
    const r = await run([]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Usage/);
  });
});

describe('exporter source guards', () => {
  const src = () => fs.readFileSync(path.join(__dirname, '..', 'scripts', 'laya-eval-export-review-sheet.js'), 'utf8');

  it('silences dotenv, whose banner goes to stdout and once corrupted the first line of the CSV', () => {
    expect(src()).toMatch(/require\('dotenv'\)\.config\(\{ quiet: true \}\)/);
  });

  it('keeps servingTime out of the exported input (it would leak the answer to Laya)', () => {
    const s = src();
    const inputBlock = s.slice(s.indexOf('input: {'), s.indexOf('source: {'));
    expect(inputBlock).not.toMatch(/servingTime/);
  });

  it('samples all seven slots, not just the four main meals', () => {
    const s = src();
    expect(s).toMatch(/servingTime: \{ \$in: SLOT_NAMES \}/);
    expect(s).not.toMatch(/'Evening Snack'\]/);
  });
});
