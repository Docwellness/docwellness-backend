/**
 * Threshold-free rank metrics (utils/layaRank.js). The fixtures are tiny
 * synthetic score tables used to check the arithmetic - not Laya output and not
 * evaluation data.
 */

const { SLOT_KEYS } = require('../utils/layaSlots');
const { rankOf, auc, chanceTopK, chanceBestRank, rankMetrics } = require('../utils/layaRank');

// Scores for all seven slots; unnamed slots get the floor.
const probs = (over, floor = 0.1) => ({ ...Object.fromEntries(SLOT_KEYS.map((k) => [k, floor])), ...over });

describe('rankOf', () => {
  it('ranks by descending probability, 1 = best', () => {
    const p = probs({ lunch: 0.9, dinner: 0.5 });
    expect(rankOf(p, 'lunch')).toBe(1);
    expect(rankOf(p, 'dinner')).toBe(2);
  });
  it('gives tied slots their average rank', () => {
    const p = probs({ lunch: 0.9, dinner: 0.9 });
    expect(rankOf(p, 'lunch')).toBe(1.5);
    expect(rankOf(p, 'dinner')).toBe(1.5);
    expect(rankOf(probs({}), 'lunch')).toBe(4); // all seven tied: (1+...+7)/7
  });
  it('is null for an unscored slot', () => {
    expect(rankOf({ lunch: 0.5 }, 'dinner')).toBeNull();
    expect(rankOf(null, 'lunch')).toBeNull();
  });
});

describe('chance levels (what random ranking would score)', () => {
  it('chanceTopK is exact for hypergeometric draws', () => {
    expect(chanceTopK(1, 1)).toBeCloseTo(1 / 7, 10);
    expect(chanceTopK(1, 2)).toBeCloseTo(2 / 7, 10);
    expect(chanceTopK(2, 1)).toBeCloseTo(2 / 7, 10);
    expect(chanceTopK(2, 2)).toBeCloseTo(1 - (5 * 4) / (7 * 6), 10); // 1 - C(5,2)/C(7,2) = 11/21
    expect(chanceTopK(7, 1)).toBe(1);
    expect(chanceTopK(0, 1)).toBeNull();
  });
  it('chanceBestRank is (n+1)/(m+1)', () => {
    expect(chanceBestRank(1)).toBe(4);
    expect(chanceBestRank(3)).toBe(2);
  });
});

describe('auc', () => {
  it('is 1 when every positive beats every negative, 0.5 for identical scores, 0 when reversed', () => {
    expect(auc([0.9, 0.8], [0.2, 0.1])).toBe(1);
    expect(auc([0.5, 0.5], [0.5])).toBe(0.5);
    expect(auc([0.1], [0.9])).toBe(0);
  });
  it('is null when a side is empty', () => {
    expect(auc([], [0.5])).toBeNull();
    expect(auc([0.5], [])).toBeNull();
  });
});

describe('rankMetrics', () => {
  it('scores a perfect ranker: best accepted slot always first, AUC 1', () => {
    const items = [
      { accepted: ['lunch'], probs: probs({ lunch: 0.9 }) },
      { accepted: ['dinner'], probs: probs({ dinner: 0.8 }) },
      { accepted: ['breakfast', 'brunch'], probs: probs({ breakfast: 0.7, brunch: 0.6 }) },
    ];
    const m = rankMetrics(items);
    expect(m.n).toBe(3);
    expect(m.meanBestAcceptedRank).toBe(1);
    expect(m.topK[1].rate).toBe(1);
    expect(m.topK[1].chance).toBeCloseTo((1 / 7 + 1 / 7 + 2 / 7) / 3, 3);
    expect(m.aucBySlot.lunch.auc).toBe(1);
    expect(m.macroAuc).toBe(1);
  });

  it('scores a ranker with no signal near chance: constant scores give AUC 0.5 and rank 4', () => {
    const items = ['lunch', 'dinner', 'breakfast', 'brunch'].map((s) => ({ accepted: [s], probs: probs({}) }));
    const m = rankMetrics(items);
    expect(m.meanBestAcceptedRank).toBe(4);
    expect(m.chanceMeanBestRank).toBe(4);
    expect(m.macroAuc).toBe(0.5);
  });

  it('exposes a per-slot bias: always scoring Morning Drink high looks fine thresholded but has no signal', () => {
    // Every recipe scores Morning Drink highest (a slot bias); the real slot only gets a small lift.
    const biased = (slot) => ({ accepted: [slot], probs: probs({ morning_drink: 0.9, [slot]: slot === 'morning_drink' ? 0.9 : 0.4 }) });
    const items = ['lunch', 'dinner', 'breakfast', 'brunch', 'morning_drink', 'night_drink'].map(biased);
    const m = rankMetrics(items);
    expect(m.topK[1].rate).toBeLessThan(0.3); // the bias wins the top pick
    // Per-slot AUC still sees the lift for slots that have it (lunch scores 0.4 for lunch recipes, 0.1 elsewhere)
    expect(m.aucBySlot.lunch.auc).toBe(1);
    // After removing each slot's own bias, the real slot comes out on top far more often
    expect(m.biasCorrectedTop1.rate).toBeGreaterThan(m.topK[1].rate);
  });

  it('handles several accepted slots: the BEST accepted rank counts', () => {
    const m = rankMetrics([{ accepted: ['lunch', 'dinner'], probs: probs({ dinner: 0.9, lunch: 0.5 }) }]);
    expect(m.meanBestAcceptedRank).toBe(1);
    expect(m.topK[1].hit).toBe(1);
  });

  it('skips items with no accepted slots or no scores, and returns nulls when nothing is scorable', () => {
    const m = rankMetrics([{ accepted: [], probs: probs({ lunch: 0.9 }) }, { accepted: ['lunch'], probs: null }, { accepted: ['lunch'], probs: {} }]);
    expect(m.n).toBe(0);
    expect(m.macroAuc).toBeNull();
    expect(m.meanBestAcceptedRank).toBeNull();
  });
});
