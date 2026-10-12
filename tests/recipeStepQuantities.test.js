const { rewriteStepQuantities } = require('../utils/recipeStepQuantities');

const paneer = [
  { name: 'Low-Fat Paneer', quantity: 48.16, unit: 'g' },
  { name: 'Lemon', quantity: 0.24, unit: 'piece' },
  { name: 'Black Pepper', quantity: 0.12, unit: 'tsp' },
];

describe('rewriteStepQuantities', () => {
  test('rewrites stale quantities to the version ingredient quantities', () => {
    const { steps, changes } = rewriteStepQuantities(
      ['Cut the 100 g of Low-Fat Paneer into cubes.', 'Squeeze the juice of 0.5 piece of Lemon.', 'Add 0.25 tsp of Black Pepper.'],
      paneer
    );
    expect(steps).toEqual([
      'Cut the 48.16 g of Low-Fat Paneer into cubes.',
      'Squeeze the juice of 0.24 piece of Lemon.',
      'Add 0.12 tsp of Black Pepper.',
    ]);
    expect(changes).toHaveLength(3);
  });

  test('is idempotent and leaves matching quantities alone', () => {
    const once = rewriteStepQuantities(['Cut the 100 g of Low-Fat Paneer.'], paneer).steps;
    expect(rewriteStepQuantities(once, paneer).steps).toEqual(once);
  });

  test('handles compact "50g curd" style without "of"', () => {
    const { steps } = rewriteStepQuantities(['Add 50g curd.'], [{ name: 'curd', quantity: 25, unit: 'g' }]);
    expect(steps).toEqual(['Add 25g curd.']);
  });

  test('scales a bracketed equivalent by the same ratio', () => {
    const { steps } = rewriteStepQuantities(['Add 2 g (1 tsp) of coriander seeds.'], [{ name: 'coriander seeds', quantity: 1, unit: 'g' }]);
    expect(steps).toEqual(['Add 1 g (0.5 tsp) of coriander seeds.']);
  });

  test('skips a unit mismatch and reports it', () => {
    const skipped = [];
    const { steps } = rewriteStepQuantities(['Heat 1 tsp oil.'], [{ name: 'oil', quantity: 3.75, unit: 'ml' }], { onSkip: (i) => skipped.push(i) });
    expect(steps).toEqual(['Heat 1 tsp oil.']);
    expect(skipped[0].reason).toMatch(/unit differs/);
  });

  test('skips an ingredient quoted in several steps (split use)', () => {
    const skipped = [];
    const input = ['Add 250 ml of water.', 'Later add 250 ml of water.'];
    const { steps } = rewriteStepQuantities(input, [{ name: 'water', quantity: 400, unit: 'ml' }], { onSkip: (i) => skipped.push(i) });
    expect(steps).toEqual(input);
    expect(skipped).toHaveLength(2);
  });

  test('does not touch steps without quantities or non-string entries', () => {
    expect(rewriteStepQuantities(['Boil milk', 'Add oats'], paneer).steps).toEqual(['Boil milk', 'Add oats']);
    expect(rewriteStepQuantities(undefined, paneer).steps).toEqual([]);
  });
});
