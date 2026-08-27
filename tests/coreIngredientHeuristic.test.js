/**
 * utils/coreIngredientHeuristic.js - the deterministic category-priority
 * heuristic used to correct a zero-core AI generation response
 * (utils/openaiClient.js) and to default a manually-authored recipe's
 * core ingredient(s) when none is specified (controllers/dietician/
 * uploadRecipieController.js). Pure function, no DB/network needed.
 */
const { applyCoreIngredientHeuristic, hasCoreIngredient } = require('../utils/coreIngredientHeuristic');

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
