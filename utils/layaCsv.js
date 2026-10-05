/**
 * CSV round trip for the Laya evaluation review sheet: a dietician reviews a
 * spreadsheet, not JSON. scripts/laya-eval-export-review-sheet.js writes it
 * (--format=csv) and scripts/laya-eval-import-review-sheet.js reads it back
 * into tests/laya/<category>.json.
 *
 * The sheet is BLIND by default: it does not show the recipe's existing
 * servingTime or its meal type (the "source" label), so the reviewer decides
 * from the recipe alone and is not anchored. The source label is not needed to
 * score anything; it stays on the recipe in the database and is joined back by
 * `id` when analysing. (`withSource` adds it for a non-blind sheet.)
 *
 * Pure functions, no I/O. The importer is deliberately STRICT: a row only
 * becomes evaluation data when a reviewer is named AND its expected values are
 * valid. Anything half-filled is reported as an error, never guessed at, so a
 * typo can't quietly become ground truth.
 */

const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'];
const PROTEIN_LEVELS = ['low', 'moderate', 'high'];
// Blank status = not reviewed yet. 'skipped' = looked at and deliberately
// excluded (a tea, a supplement, a side); 'unsure' = needs a second opinion.
const REVIEW_STATUSES = ['reviewed', 'skipped', 'unsure'];

// What the dietician sees. No servingTime, no source meal type: blind.
const BLIND_COLUMNS = [
  'id',
  'name',
  'cuisine',
  'category',
  'ingredients', // names joined with "; " (ingredient names may contain commas)
  'expected_meal_type', // REVIEWER FILLS: breakfast | lunch | dinner | snack
  'expected_protein_level', // REVIEWER FILLS (optional): low | moderate | high
  'reviewer', // REVIEWER FILLS: their name or initials
  'review_status', // REVIEWER FILLS: reviewed | skipped | unsure (blank = not reviewed)
  'review_notes', // optional free text, e.g. why a row was skipped
];
const SOURCE_COLUMNS = ['servingTime', 'source_meal_type'];

function csvColumns({ withSource = false } = {}) {
  if (!withSource) return BLIND_COLUMNS;
  const i = BLIND_COLUMNS.indexOf('category') + 1;
  return [...BLIND_COLUMNS.slice(0, i), ...SOURCE_COLUMNS, ...BLIND_COLUMNS.slice(i)];
}

function escapeField(value) {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows, columns = BLIND_COLUMNS) {
  const lines = [columns.map(escapeField).join(',')];
  for (const row of rows) lines.push(columns.map((c) => escapeField(row[c])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/** RFC 4180-style parser: quoted fields, "" escapes, embedded newlines, CRLF, BOM. */
function parseCsv(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else field += ch;
  }
  if (inQuotes) throw new Error('CSV has an unterminated quoted field');
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  // Drop fully blank lines (spreadsheets love trailing ones).
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function parseCsvObjects(text) {
  const [header, ...body] = parseCsv(text);
  if (!header) return [];
  const names = header.map((h) => h.trim());
  return body.map((r) => Object.fromEntries(names.map((n, i) => [n, r[i] === undefined ? '' : r[i]])));
}

/**
 * Review-sheet rows (JSON, as the exporter builds them) -> flat CSV rows.
 * Blind unless `withSource`; the reviewer columns are always empty.
 */
function sheetToCsvRows(sheet, { withSource = false } = {}) {
  return sheet.map((r) => {
    const rec = (r.input && r.input.recipe) || {};
    const row = {
      id: r.id,
      name: rec.name,
      cuisine: rec.cuisine || '',
      category: rec.category || '',
      ingredients: (rec.ingredients || []).map((i) => i.name).join('; '),
      expected_meal_type: '',
      expected_protein_level: '',
      reviewer: '',
      review_status: '',
      review_notes: '',
    };
    if (withSource) {
      row.servingTime = (r.source && r.source.servingTime) || '';
      row.source_meal_type = (r.source && r.source.meal_type) || '';
    }
    return row;
  });
}

/**
 * Filled CSV rows -> dataset examples.
 *   status "reviewed" (or blank, for older sheets) with a reviewer and valid
 *     expected values            -> an example, reviewed_by: "dietician"
 *   status "skipped" / "unsure"  -> recorded and counted, never scored
 *   no status, reviewer or values -> still pending (counted, not an error)
 *   anything half-filled or invalid -> an ERROR
 * The recipe's servingTime / source meal type are NEVER copied into `input`:
 * `input` is what Laya will be shown, and those would leak the answer. A
 * source meal type column (`source_meal_type`, or the older `proposed_meal_type`)
 * is kept outside `input`, as metadata only.
 * Returns { examples, errors, pending, skipped, unsure }. Callers must refuse
 * to write when there are errors.
 */
function csvToDataset(objects) {
  const examples = [];
  const errors = [];
  const skipped = [];
  const unsure = [];
  let pending = 0;

  objects.forEach((o, idx) => {
    const line = idx + 2; // +1 for the header, +1 for 1-based lines
    const reviewer = (o.reviewer || '').trim();
    const meal = (o.expected_meal_type || '').trim().toLowerCase();
    const protein = (o.expected_protein_level || '').trim().toLowerCase();
    const status = (o.review_status || '').trim().toLowerCase();
    const notes = (o.review_notes || '').trim();
    const hasValues = Boolean(meal || protein);
    const fail = (message) => errors.push({ line, id: o.id, message });

    if (status && !REVIEW_STATUSES.includes(status)) {
      fail(`review_status "${o.review_status}" must be one of: ${REVIEW_STATUSES.join(', ')} (or blank = not reviewed)`);
      return;
    }

    if (status === 'skipped' || status === 'unsure') {
      if (hasValues) {
        fail(`review_status is "${status}" but expected values are filled - clear them, or set the status to reviewed`);
        return;
      }
      if (!reviewer) {
        fail(`review_status "${status}" needs a reviewer name`);
        return;
      }
      (status === 'skipped' ? skipped : unsure).push({ id: o.id, name: o.name, notes });
      return;
    }

    // status is "reviewed" or blank (older sheets with no status column)
    if (!reviewer) {
      if (hasValues || status === 'reviewed') fail('has expected values or status "reviewed" but no reviewer - add the reviewer name');
      else pending += 1;
      return;
    }
    if (!o.id) {
      fail('missing id');
      return;
    }
    if (!hasValues) {
      fail('reviewer is set but no expected values were entered (use review_status "skipped" to exclude a row)');
      return;
    }
    if (meal && !MEAL_TYPES.includes(meal)) {
      fail(`expected_meal_type "${o.expected_meal_type}" must be one of: ${MEAL_TYPES.join(', ')}`);
      return;
    }
    if (protein && !PROTEIN_LEVELS.includes(protein)) {
      fail(`expected_protein_level "${o.expected_protein_level}" must be one of: ${PROTEIN_LEVELS.join(', ')}`);
      return;
    }

    const expected = {};
    if (meal) expected.meal_type = meal;
    if (protein) expected.protein_level = protein;
    const sourceMeal = (o.source_meal_type || o.proposed_meal_type || '').trim().toLowerCase();
    const example = {
      id: o.id,
      input: {
        recipe: {
          name: o.name,
          cuisine: o.cuisine || null,
          category: o.category || null,
          // deliberately no servingTime: see the header comment
          ingredients: (o.ingredients || '')
            .split(';')
            .map((n) => n.trim())
            .filter(Boolean)
            .map((n) => ({ name: n })),
        },
      },
      expected,
      reviewed_by: 'dietician',
      reviewer, // who signed it off, for traceability
    };
    if (notes) example.review_notes = notes;
    if (sourceMeal) example.source = { meal_type: sourceMeal }; // metadata only, never sent to Laya
    examples.push(example);
  });

  const seen = new Set();
  for (const e of examples) {
    if (seen.has(e.id)) errors.push({ line: null, id: e.id, message: 'duplicate id in the sheet' });
    seen.add(e.id);
  }
  return { examples, errors, pending, skipped, unsure };
}

module.exports = {
  MEAL_TYPES,
  PROTEIN_LEVELS,
  REVIEW_STATUSES,
  BLIND_COLUMNS,
  SOURCE_COLUMNS,
  csvColumns,
  toCsv,
  parseCsv,
  parseCsvObjects,
  sheetToCsvRows,
  csvToDataset,
};
