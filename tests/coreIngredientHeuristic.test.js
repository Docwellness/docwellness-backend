/**
 * utils/coreIngredientHeuristic.js - the deterministic category-priority
 * heuristic used to correct a zero-core AI generation response
 * (utils/openaiClient.js) and to default a manually-authored recipe's
 * core ingredient(s) when none is specified (controllers/dietician/
 * uploadRecipieController.js). Pure function, no DB/network needed.
 */
const {
  applyCoreIngredientHeuristic,
  hasCoreIngredient,
  deriveComponentsFromIngredients,
  componentsAreDerivable,
} = require('../utils/coreIngredientHeuristic');

describe('applyCoreIngredientHeuristic', () => {
  test('single-category dish (Chapati-style): the lone Carbohydrate ingredient is core, rest sub', () => {
    const result = applyCoreIngredientHeuristic([
      { name: 'Whole Wheat Flour', category: 'Carbohydrate' },
      { name: 'Water', category: 'Other' },
      { name: 'Salt', category: 'Spice' },
      { name: 'Ghee', category: 'Oil/Fat' },
    ]);
    expect(result.map((i) => [i.name, i.role])).toEqual([
      ['Whole Wheat Flour', 'core'],
      ['Water', 'sub'],
      ['Salt', 'sub'],
      ['Ghee', 'sub'],
    ]);
  });

  test('combo dish (Mixed Vegetable-style): every ingredient in the highest present category is core together', () => {
    const result = applyCoreIngredientHeuristic([
      { name: 'Carrot', category: 'Vegetable' },
      { name: 'Beans', category: 'Vegetable' },
      { name: 'Peas', category: 'Vegetable' },
      { name: 'Cauliflower', category: 'Vegetable' },
      { name: 'Oil', category: 'Oil/Fat' },
      { name: 'Salt', category: 'Spice' },
    ]);
    expect(result.filter((i) => i.role === 'core').map((i) => i.name)).toEqual(
      expect.arrayContaining(['Carrot', 'Beans', 'Peas', 'Cauliflower'])
    );
    expect(result.filter((i) => i.role === 'sub').map((i) => i.name)).toEqual(
      expect.arrayContaining(['Oil', 'Salt'])
    );
  });

  test('a higher-priority category present beats a larger lower-priority group (Khichdi-style: one Grain outranks several Vegetables)', () => {
    const result = applyCoreIngredientHeuristic([
      { name: 'Rice', category: 'Grain' },
      { name: 'Carrot', category: 'Vegetable' },
      { name: 'Peas', category: 'Vegetable' },
      { name: 'Beans', category: 'Vegetable' },
    ]);
    expect(result.find((i) => i.name === 'Rice').role).toBe('core');
    expect(result.filter((i) => i.name !== 'Rice').every((i) => i.role === 'sub')).toBe(true);
  });

  test('missing/unrecognized category is treated as the lowest priority (Other), not core', () => {
    const result = applyCoreIngredientHeuristic([
      { name: 'Mystery Ingredient' },
      { name: 'Rice', category: 'Grain' },
    ]);
    expect(result.find((i) => i.name === 'Rice').role).toBe('core');
    expect(result.find((i) => i.name === 'Mystery Ingredient').role).toBe('sub');
  });

  test('never mutates the input array', () => {
    const input = [{ name: 'Rice', category: 'Grain' }];
    const result = applyCoreIngredientHeuristic(input);
    expect(input[0].role).toBeUndefined();
    expect(result).not.toBe(input);
    expect(result[0]).not.toBe(input[0]);
  });

  test('empty/non-array input is returned as-is', () => {
    expect(applyCoreIngredientHeuristic([])).toEqual([]);
    expect(applyCoreIngredientHeuristic(null)).toEqual([]);
    expect(applyCoreIngredientHeuristic(undefined)).toEqual([]);
  });
});

describe('hasCoreIngredient', () => {
  test('true when at least one ingredient is role: core', () => {
    expect(hasCoreIngredient([{ role: 'sub' }, { role: 'core' }])).toBe(true);
  });

  test('false when every ingredient is sub, or role is missing entirely', () => {
    expect(hasCoreIngredient([{ role: 'sub' }, { role: 'sub' }])).toBe(false);
    expect(hasCoreIngredient([{ name: 'Legacy ingredient' }])).toBe(false);
    expect(hasCoreIngredient([])).toBe(false);
    expect(hasCoreIngredient(null)).toBe(false);
  });
});

describe('deriveComponentsFromIngredients', () => {
  test('includes only core ingredients, in order, as {label, quantity, unit}', () => {
    const result = deriveComponentsFromIngredients([
      { name: 'Dates', quantity: 1, unit: 'nos', role: 'core' },
      { name: 'Figs', quantity: 1, unit: 'nos', role: 'core' },
      { name: 'Almonds', quantity: 2, unit: 'nos', role: 'core' },
      { name: 'Walnuts', quantity: 2, unit: 'nos', role: 'core' },
      { name: 'Water', quantity: 250, unit: 'ml', role: 'sub' },
    ]);
    expect(result).toEqual([
      { label: 'Dates', quantity: 1, unit: 'nos' },
      { label: 'Figs', quantity: 1, unit: 'nos' },
      { label: 'Almonds', quantity: 2, unit: 'nos' },
      { label: 'Walnuts', quantity: 2, unit: 'nos' },
    ]);
  });

  test('excludes sub ingredients entirely', () => {
    const result = deriveComponentsFromIngredients([
      { name: 'Salt', quantity: 1, unit: 'g', role: 'sub' },
    ]);
    expect(result).toEqual([]);
  });

  test('never mutates the input array', () => {
    const input = [{ name: 'Rice', quantity: 1, unit: 'g', role: 'core' }];
    const result = deriveComponentsFromIngredients(input);
    expect(result).not.toBe(input);
    expect(result[0]).not.toBe(input[0]);
  });

  test('empty/non-array input returns []', () => {
    expect(deriveComponentsFromIngredients([])).toEqual([]);
    expect(deriveComponentsFromIngredients(null)).toEqual([]);
    expect(deriveComponentsFromIngredients(undefined)).toEqual([]);
  });
});

describe('componentsAreDerivable', () => {
  const ingredients = [
    { name: 'Dates', role: 'core' },
    { name: 'Figs', role: 'core' },
    { name: 'Almonds', role: 'core' },
    { name: 'Walnuts', role: 'core' },
    { name: 'Water', role: 'sub' },
  ];

  test('true when every component label matches an ingredient name (case/whitespace-insensitive)', () => {
    expect(
      componentsAreDerivable(
        [
          { label: 'Dates', quantity: 1, unit: 'nos' },
          { label: ' figs ', quantity: 1, unit: 'nos' },
          { label: 'ALMONDS', quantity: 2, unit: 'nos' },
          { label: 'Walnuts', quantity: 2, unit: 'nos' },
        ],
        ingredients
      )
    ).toBe(true);
  });

  test('false when some components match and some do not (ambiguous)', () => {
    expect(
      componentsAreDerivable(
        [
          { label: 'Dates', quantity: 1, unit: 'nos' },
          { label: 'Mystery Blend', quantity: 1, unit: 'bowl' },
        ],
        ingredients
      )
    ).toBe(false);
  });

  test('false for a composite dish whose components are prepared sub-dishes, not ingredients', () => {
    expect(
      componentsAreDerivable(
        [
          { label: 'Pithla', quantity: 1, unit: 'bowl' },
          { label: 'Bhakri', quantity: 2, unit: 'piece' },
        ],
        [
          { name: 'Besan', role: 'core' },
          { name: 'Jowar Flour', role: 'core' },
          { name: 'Turmeric', role: 'sub' },
        ]
      )
    ).toBe(false);
  });

  test('empty/missing components counts as derivable (nothing to conflict with)', () => {
    expect(componentsAreDerivable([], ingredients)).toBe(true);
    expect(componentsAreDerivable(undefined, ingredients)).toBe(true);
    expect(componentsAreDerivable(null, ingredients)).toBe(true);
  });
});
