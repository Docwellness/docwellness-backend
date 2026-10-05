/**
 * Tests for the review-sheet CSV round trip (utils/layaCsv.js and
 * scripts/laya-eval-import-review-sheet.js). The rows below are tiny inline
 * fixtures exercising parsing and validation - not evaluation data.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const { CSV_COLUMNS, toCsv, parseCsv, parseCsvObjects, sheetToCsvRows, csvToDataset } = require('../utils/layaCsv');

describe('toCsv / parseCsv', () => {
  it('quotes commas, quotes and newlines, and round-trips them', () => {
    const rows = [
      { id: '1', name: 'Dal, Rice & "Papad"', ingredients: 'toor dal; rice\nghee', cuisine: '' },
      { id: '2', name: 'Plain', ingredients: '', cuisine: 'Indian' },
    ];
    const csv = toCsv(rows, ['id', 'name', 'ingredients', 'cuisine']);
    const objects = parseCsvObjects(csv);
    expect(objects).toEqual([
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

describe('sheetToCsvRows', () => {
  it('flattens a review-sheet row and leaves the reviewer columns blank', () => {
    const [row] = sheetToCsvRows([
      {
        id: 'r1',
        input: { recipe: { name: 'Poha', cuisine: 'Indian', category: 'Indian', servingTime: 'Breakfast', ingredients: [{ name: 'poha' }, { name: 'peanuts' }] } },
        proposed: { meal_type: 'breakfast' },
        expected: null,
        reviewed_by: null,
      },
    ]);
    expect(row).toMatchObject({ id: 'r1', name: 'Poha', ingredients: 'poha; peanuts', proposed_meal_type: 'breakfast', expected_meal_type: '', expected_protein_level: '', reviewer: '' });
    expect(Object.keys(row)).toEqual(CSV_COLUMNS);
  });
});

describe('csvToDataset (strict)', () => {
  const row = (over) => ({
    id: 'r1', name: 'Poha', cuisine: 'Indian', category: 'Indian', servingTime: 'Breakfast',
    ingredients: 'poha; peanuts, roasted; onion', proposed_meal_type: 'breakfast',
    expected_meal_type: '', expected_protein_level: '', reviewer: '', ...over,
  });

  it('turns a fully reviewed row into an example, normalising case and whitespace', () => {
    const { examples, errors, pending } = csvToDataset([row({ expected_meal_type: ' Breakfast ', expected_protein_level: 'MODERATE', reviewer: ' Dr A ' })]);
    expect(errors).toEqual([]);
    expect(pending).toBe(0);
    expect(examples).toHaveLength(1);
    expect(examples[0]).toMatchObject({
      id: 'r1',
      expected: { meal_type: 'breakfast', protein_level: 'moderate' },
      reviewed_by: 'dietician',
      reviewer: 'Dr A',
    });
    // "; " separates ingredients, so a name containing a comma survives intact
    expect(examples[0].input.recipe.ingredients).toEqual([{ name: 'poha' }, { name: 'peanuts, roasted' }, { name: 'onion' }]);
  });

  it('accepts a meal-type-only or protein-only review', () => {
    const { examples } = csvToDataset([
      row({ id: 'a', expected_meal_type: 'lunch', reviewer: 'x' }),
      row({ id: 'b', expected_protein_level: 'high', reviewer: 'x' }),
    ]);
    expect(examples[0].expected).toEqual({ meal_type: 'lunch' });
    expect(examples[1].expected).toEqual({ protein_level: 'high' });
  });

  it('leaves rows with no reviewer and no values as pending, not errors', () => {
    const r = csvToDataset([row({}), row({ id: 'r2' })]);
    expect(r).toMatchObject({ examples: [], errors: [], pending: 2 });
  });

  it('refuses half-filled and invalid rows instead of guessing', () => {
    const { examples, errors } = csvToDataset([
      row({ id: 'e1', expected_meal_type: 'lunch' }), // values but no reviewer
      row({ id: 'e2', reviewer: 'x' }), // reviewer but no values
      row({ id: 'e3', reviewer: 'x', expected_meal_type: 'brunch' }), // not a valid meal type
      row({ id: 'e4', reviewer: 'x', expected_meal_type: 'lunch', expected_protein_level: 'medium' }), // not a valid level
      row({ id: '', reviewer: 'x', expected_meal_type: 'lunch' }), // no id
    ]);
    expect(examples).toEqual([]);
    expect(errors.map((e) => e.id)).toEqual(['e1', 'e2', 'e3', 'e4', '']);
    expect(errors[0].message).toMatch(/no reviewer/);
    expect(errors[1].message).toMatch(/no expected values/);
    expect(errors[2].message).toMatch(/must be one of: breakfast, lunch, dinner, snack/);
    expect(errors[3].message).toMatch(/low, moderate, high/);
    expect(errors.map((e) => e.line)).toEqual([2, 3, 4, 5, 6]); // header is line 1
  });

  it('flags a duplicate id', () => {
    const { errors } = csvToDataset([
      row({ id: 'd', reviewer: 'x', expected_meal_type: 'lunch' }),
      row({ id: 'd', reviewer: 'x', expected_meal_type: 'dinner' }),
    ]);
    expect(errors).toEqual([{ line: null, id: 'd', message: 'duplicate id in the sheet' }]);
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

  const sheet = (rows) => toCsv(rows);
  const base = { id: 'r1', name: 'A', cuisine: '', category: '', servingTime: 'Lunch', ingredients: 'x; y', proposed_meal_type: 'lunch', expected_meal_type: '', expected_protein_level: '', reviewer: '' };

  it('writes only reviewed rows, skips pending ones, and the output is scoreable by the evaluation runner', async () => {
    const csv = path.join(dir, 'a.csv');
    const out = path.join(dir, 'recipe_classification.json');
    fs.writeFileSync(csv, sheet([
      { ...base, id: 'r1', expected_meal_type: 'lunch', expected_protein_level: 'high', reviewer: 'Dr A' },
      { ...base, id: 'r2' }, // pending
    ]));
    const r = await run([`--in=${csv}`, `--out=${out}`]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Imported 1 reviewed row\(s\); 1 still pending/);
    const data = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(data).toHaveLength(1);
    const { isReviewed } = require('../utils/layaEval');
    expect(isReviewed(data[0])).toBe(true); // the same gate the evaluation runner applies
    expect(data[0].input.recipe.ingredients).toEqual([{ name: 'x' }, { name: 'y' }]);
  });

  it('merges by id on a later import (a re-review replaces the earlier row) unless --replace', async () => {
    const out = path.join(dir, 'merge.json');
    const first = path.join(dir, 'm1.csv');
    const second = path.join(dir, 'm2.csv');
    fs.writeFileSync(first, sheet([{ ...base, id: 'a', expected_meal_type: 'lunch', reviewer: 'x' }, { ...base, id: 'b', expected_meal_type: 'dinner', reviewer: 'x' }]));
    fs.writeFileSync(second, sheet([{ ...base, id: 'b', expected_meal_type: 'snack', reviewer: 'y' }, { ...base, id: 'c', expected_meal_type: 'breakfast', reviewer: 'y' }]));
    await run([`--in=${first}`, `--out=${out}`]);
    await run([`--in=${second}`, `--out=${out}`]);
    const merged = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(merged.map((e) => `${e.id}:${e.expected.meal_type}`).sort()).toEqual(['a:lunch', 'b:snack', 'c:breakfast']);

    await run([`--in=${second}`, `--out=${out}`, '--replace']);
    expect(JSON.parse(fs.readFileSync(out, 'utf8')).map((e) => e.id).sort()).toEqual(['b', 'c']);
  });

  it('writes NOTHING and exits non-zero when any row has a problem', async () => {
    const csv = path.join(dir, 'bad.csv');
    const out = path.join(dir, 'never.json');
    fs.writeFileSync(csv, sheet([
      { ...base, id: 'ok', expected_meal_type: 'lunch', reviewer: 'x' },
      { ...base, id: 'bad', expected_meal_type: 'lunchtime', reviewer: 'x' },
    ]));
    const r = await run([`--in=${csv}`, `--out=${out}`]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Nothing was written/);
    expect(r.stderr).toMatch(/line 3 \(id bad\)/);
    expect(fs.existsSync(out)).toBe(false); // the good row was not written either
  });

  it('requires --in', async () => {
    const r = await run([]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Usage/);
  });
});

describe('exporter --stdout hygiene', () => {
  it('silences dotenv, whose banner goes to stdout and once corrupted the first line of the CSV', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'laya-eval-export-review-sheet.js'), 'utf8');
    expect(src).toMatch(/require\('dotenv'\)\.config\(\{ quiet: true \}\)/);
  });
});
