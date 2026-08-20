/**
 * scripts/foodItemNutritionData.js - a hand-compiled data table, not
 * logic, but worth a sanity check on the entry itself: catches a typo'd
 * decimal or a missing macro field before it poisons every RecipeVersion
 * that resolves through it. Also cross-checks against
 * canonical-ingredients-data.js, since scripts/seed-food-item-nutrition.js
 * joins the two by canonicalName.
 */

const { FOOD_ITEM_NUTRITION_DATA } = require('../scripts/foodItemNutritionData');
const { CANONICAL_INGREDIENTS } = require('../scripts/canonical-ingredients-data');

describe('FOOD_ITEM_NUTRITION_DATA', () => {
  const entries = Object.entries(FOOD_ITEM_NUTRITION_DATA);

  test('every entry has all 5 macro fields as finite non-negative numbers', () => {
    for (const [name, macros] of entries) {
      for (const field of ['calories', 'protein', 'carbs', 'fats', 'fiber']) {
        expect(typeof macros[field]).toBe('number');
        expect(Number.isFinite(macros[field])).toBe(true);
        expect(macros[field]).toBeGreaterThanOrEqual(0);
      }
      expect(name.trim()).toBe(name); // no accidental leading/trailing whitespace in a key
    }
  });

  test('calories roughly reconciles with 4*protein + 4*carbs + 9*fats (catches a misplaced decimal)', () => {
    const TOLERANCE = 0.35; // wide band - fiber-heavy spices skew the 4/4/9 Atwater estimate well beyond whole foods
    // Baking Powder is mostly non-caloric sodium bicarbonate - its published
    // ~53 kcal/100g figure legitimately doesn't reconcile with Atwater math
    // on its ~28g "carbs" (mostly cornstarch anticaking agent), same reason
    // Water/Salt are excluded. Not a typo - and used in <5g quantities per
    // recipe regardless, so the exact figure barely matters in practice.
    const ATWATER_EXEMPT = new Set(['Baking Powder']);
    for (const [name, macros] of entries) {
      if (ATWATER_EXEMPT.has(name)) continue;
      const computed = 4 * macros.protein + 4 * macros.carbs + 9 * macros.fats;
      if (computed === 0 && macros.calories === 0) continue; // Water/Salt - nothing to reconcile
      const deviation = Math.abs(macros.calories - computed) / Math.max(macros.calories, computed, 1);
      expect(deviation).toBeLessThan(TOLERANCE);
    }
  });

  test('every CANONICAL_INGREDIENTS entry has a matching nutrition entry (full Tier-1 coverage)', () => {
    const missing = CANONICAL_INGREDIENTS.map((c) => c.canonicalName).filter((name) => !(name in FOOD_ITEM_NUTRITION_DATA));
    expect(missing).toEqual([]);
  });

  test('no orphan nutrition entries with no matching canonical ingredient', () => {
    const canonicalNames = new Set(CANONICAL_INGREDIENTS.map((c) => c.canonicalName));
    const orphans = Object.keys(FOOD_ITEM_NUTRITION_DATA).filter((name) => !canonicalNames.has(name));
    expect(orphans).toEqual([]);
  });
});
