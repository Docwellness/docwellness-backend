/**
 * CSV round trip for the Laya evaluation review sheet: a dietician reviews a
 * spreadsheet, not JSON. scripts/laya-eval-export-review-sheet.js writes it
 * (--format=csv) and scripts/laya-eval-import-review-sheet.js reads it back
 * into tests/laya/<category>.json.
 *
 * Pure functions, no I/O. The importer is deliberately STRICT: a row only
 * becomes evaluation data when a reviewer is named AND its expected values are
 * valid. Anything half-filled is reported as an error, never guessed at, so a
 * typo can't quietly become ground truth.
 */

const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'];
const PROTEIN_LEVELS = ['low', 'moderate', 'high'];

const CSV_COLUMNS = [
  'id',
  'name',
  'cuisine',
  'category',
  'servingTime',
  'ingredients', // names joined with "; " (ingredient names may contain commas)
  'proposed_meal_type', // the recipe's existing slot - a starting point only
  'expected_meal_type', // REVIEWER FILLS: breakfast | lunch | dinner | snack
  'expected_protein_level', // REVIEWER FILLS (optional): low | moderate | high
  'reviewer', // REVIEWER FILLS: their name or initials; blank = not reviewed
];

function escapeField(value) {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows, columns = CSV_COLUMNS) {
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

/** Review-sheet rows (JSON, as the exporter builds them) -> flat CSV rows. */
function sheetToCsvRows(sheet) {
  return sheet.map((r) => {
    const rec = (r.input && r.input.recipe) || {};
    return {
      id: r.id,
      name: rec.name,
      cuisine: rec.cuisine || '',
      category: rec.category || '',
      servingTime: rec.servingTime || '',
      ingredients: (rec.ingredients || []).map((i) => i.name).join('; '),
      proposed_meal_type: (r.proposed && r.proposed.meal_type) || '',
      expected_meal_type: '',
      expected_protein_level: '',
      reviewer: '',
    };
  });
}

/**
 * Filled CSV rows -> dataset examples.
 *   - reviewer blank          -> still pending (counted, not an error)
 *   - reviewer set, values ok -> an example with reviewed_by: "dietician"
 *   - reviewer set, anything wrong or nothing expected -> an ERROR
 * Returns { examples, errors, pending }. Callers must refuse to write when
 * there are errors.
 */
function csvToDataset(objects) {
  const examples = [];
  const errors = [];
  let pending = 0;

  objects.forEach((o, idx) => {
    const line = idx + 2; // +1 for the header, +1 for 1-based lines
    const reviewer = (o.reviewer || '').trim();
    const meal = (o.expected_meal_type || '').trim().toLowerCase();
    const protein = (o.expected_protein_level || '').trim().toLowerCase();

    if (!reviewer) {
      if (meal || protein) {
        errors.push({ line, id: o.id, message: 'has expected values but no reviewer - add the reviewer name or clear the values' });
      } else pending += 1;
      return;
    }
    if (!o.id) {
      errors.push({ line, id: o.id, message: 'missing id' });
      return;
    }
    if (!meal && !protein) {
      errors.push({ line, id: o.id, message: 'reviewer is set but no expected values were entered' });
      return;
    }
    if (meal && !MEAL_TYPES.includes(meal)) {
      errors.push({ line, id: o.id, message: `expected_meal_type "${o.expected_meal_type}" must be one of: ${MEAL_TYPES.join(', ')}` });
      return;
    }
    if (protein && !PROTEIN_LEVELS.includes(protein)) {
      errors.push({ line, id: o.id, message: `expected_protein_level "${o.expected_protein_level}" must be one of: ${PROTEIN_LEVELS.join(', ')}` });
      return;
    }

    const expected = {};
    if (meal) expected.meal_type = meal;
    if (protein) expected.protein_level = protein;
    examples.push({
      id: o.id,
      input: {
        recipe: {
          name: o.name,
          cuisine: o.cuisine || null,
          category: o.category || null,
          servingTime: o.servingTime || null,
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
    });
  });

  const seen = new Set();
  for (const e of examples) {
    if (seen.has(e.id)) errors.push({ line: null, id: e.id, message: 'duplicate id in the sheet' });
    seen.add(e.id);
  }
  return { examples, errors, pending };
}

module.exports = {
  MEAL_TYPES,
  PROTEIN_LEVELS,
  CSV_COLUMNS,
  toCsv,
  parseCsv,
  parseCsvObjects,
  sheetToCsvRows,
  csvToDataset,
};
