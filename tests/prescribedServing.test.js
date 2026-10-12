const { prescribedServingLabel, prescribedServingLabelForVersion } = require('../utils/prescribedServing');

describe('prescribedServingLabel', () => {
  it('treats the 1 g placeholder as no serving', () => {
    expect(prescribedServingLabel([{ quantity: 1, unit: 'g' }])).toBeNull();
  });

  it('is null for empty, zero or unit-less components', () => {
    expect(prescribedServingLabel([])).toBeNull();
    expect(prescribedServingLabel([{ quantity: 0, unit: 'g' }])).toBeNull();
    expect(prescribedServingLabel([{ quantity: 100 }])).toBeNull();
  });

  it('sums components that share a unit', () => {
    expect(prescribedServingLabel([{ quantity: 48.16, unit: 'g' }, { quantity: 24.08, unit: 'g' }])).toBe('72.2 g');
  });

  it('keeps countable servings of 1 (1 piece is real)', () => {
    expect(prescribedServingLabel([{ quantity: 1, unit: 'piece' }])).toBe('1 piece');
  });

  it('joins mixed units', () => {
    expect(prescribedServingLabel([{ quantity: 3, unit: 'nos' }, { quantity: 1, unit: 'bowl' }])).toBe('3 nos + 1 bowl');
  });
});

describe('prescribedServingLabelForVersion', () => {
  it('falls back to ingredient quantities when components are empty', () => {
    expect(prescribedServingLabelForVersion({ components: [], ingredients: [{ rawQuantity: 100, unit: 'g' }] })).toBe('100 g');
  });

  it('is null when neither carries a real quantity', () => {
    expect(prescribedServingLabelForVersion({ components: [{ quantity: 1, unit: 'g' }], ingredients: [] })).toBeNull();
  });
});
