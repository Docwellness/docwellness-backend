/**
 * utils/servingUnits.js - countable-serving classification + 0.5-step snap.
 */

const { isCountableServing, snapCountablePortion, snapHalfStep, COUNTABLE_SERVING_UNITS } = require('../utils/servingUnits');

describe('isCountableServing', () => {
  test('a piece component is countable', () => {
    expect(isCountableServing({ label: 'Chapati', quantity: 1, unit: 'piece' })).toBe(true);
  });

  test('is case-insensitive', () => {
    expect(isCountableServing({ quantity: 1, unit: 'PIECE' })).toBe(true);
    expect(isCountableServing({ quantity: 1, unit: ' Nos ' })).toBe(true);
  });

  test('a bowl / gram / ml component is not countable', () => {
    expect(isCountableServing({ quantity: 1, unit: 'bowl' })).toBe(false);
    expect(isCountableServing({ quantity: 150, unit: 'g' })).toBe(false);
    expect(isCountableServing({ quantity: 200, unit: 'ml' })).toBe(false);
  });

  test('undefined / malformed component is not countable', () => {
    expect(isCountableServing(undefined)).toBe(false);
    expect(isCountableServing(null)).toBe(false);
    expect(isCountableServing({ quantity: 1 })).toBe(false);
  });

  test('every listed unit classifies as countable', () => {
    for (const unit of COUNTABLE_SERVING_UNITS) {
      expect(isCountableServing({ quantity: 1, unit })).toBe(true);
    }
  });
});

describe('snapCountablePortion', () => {
  test('floors a sub-1 value at 1', () => {
    expect(snapCountablePortion(0.58)).toBe(1);
    expect(snapCountablePortion(0)).toBe(1);
    expect(snapCountablePortion(0.9)).toBe(1);
  });

  test('snaps to the nearest half step', () => {
    expect(snapCountablePortion(1.72)).toBe(1.5);
    expect(snapCountablePortion(2.1)).toBe(2);
    expect(snapCountablePortion(1.25)).toBe(1.5); // .5 rounds up
    expect(snapCountablePortion(2.74)).toBe(2.5);
  });

  test('leaves an exact half step unchanged', () => {
    expect(snapCountablePortion(1)).toBe(1);
    expect(snapCountablePortion(1.5)).toBe(1.5);
    expect(snapCountablePortion(3)).toBe(3);
  });
});

describe('snapHalfStep', () => {
  test('snaps to the nearest half step without flooring at 1', () => {
    expect(snapHalfStep(0.58)).toBe(0.5);
    expect(snapHalfStep(0.7)).toBe(0.5);
    expect(snapHalfStep(0.8)).toBe(1);
    expect(snapHalfStep(1.3)).toBe(1.5);
    expect(snapHalfStep(2.1)).toBe(2);
  });

  test('never returns below 0.5', () => {
    expect(snapHalfStep(0)).toBe(0.5);
    expect(snapHalfStep(0.1)).toBe(0.5);
    expect(snapHalfStep(-3)).toBe(0.5);
  });
});
