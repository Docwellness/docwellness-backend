/**
 * Shared reference data for the ingredient-canonicalization + supplement-
 * translation migration scripts (migrate-canonical-ingredients.js,
 * translate-supplement-facts.js). Not runnable itself - a data module.
 *
 * CANONICAL_INGREDIENTS was built from a full audit of every distinct
 * ingredient name across all 91 recipes (aggregated via mongosh against the
 * live dev DB) - every alias listed here is a name that actually appears in
 * at least one recipe today, not a hypothetical. Deliberately a CURATED
 * table, not fuzzy string matching: two genuinely different ingredients
 * (e.g. "Mustard" the condiment vs "Mustard Seeds" the spice, or "Curd" vs
 * "Yogurt", or "Oil" vs "Olive Oil") are kept as separate canonical entries
 * even though they're superficially similar, so nothing gets silently
 * merged that shouldn't be. Only confirmed same-ingredient spelling/casing/
 * phrasing variants are aliased together.
 *
 * unitConversions are grams-per-1-unit reference weights, APPROXIMATE -
 * sourced from standard culinary/USDA-style average weights (a "medium
 * onion" varies in real life; these are reasonable shopping-list averages,
 * not lab measurements). Only units that plausibly apply to that ingredient
 * are given a factor.
 */

const CANONICAL_INGREDIENTS = [
  // ── Vegetables ──────────────────────────────────────────────────────
  { canonicalName: 'Onion', category: 'Vegetable', aliases: ['onion', 'onions'],
    unitConversions: { g: 1, piece: 110, tbsp: 15, cup: 160 }, friendlyUnitLabel: 'medium onion' },
  { canonicalName: 'Tomato', category: 'Vegetable', aliases: ['tomato', 'tomatoes', 'tomato puree', 'tomato paste'],
    unitConversions: { g: 1, piece: 120, tbsp: 15 }, friendlyUnitLabel: 'medium tomato' },
  { canonicalName: 'Garlic', category: 'Spice', aliases: ['garlic', 'garlic paste', 'garlic powder'],
    unitConversions: { g: 1, piece: 3, tsp: 3 }, friendlyUnitLabel: 'clove' },
  { canonicalName: 'Ginger', category: 'Spice', aliases: ['ginger', 'ginger paste', 'ginger powder'],
    unitConversions: { g: 1, piece: 10, tsp: 2 } },
  { canonicalName: 'Green Chilli', category: 'Vegetable',
    aliases: ['green chili', 'green chilli'],
    unitConversions: { g: 1, piece: 5 } },
  { canonicalName: 'Carrot', category: 'Vegetable', aliases: ['carrot'], unitConversions: { g: 1, piece: 60 } },
  { canonicalName: 'Cauliflower', category: 'Vegetable', aliases: ['cauliflower'], unitConversions: { g: 1 } },
  { canonicalName: 'Cucumber', category: 'Vegetable', aliases: ['cucumber'], unitConversions: { g: 1, piece: 150 } },
  { canonicalName: 'Beetroot', category: 'Vegetable', aliases: ['beetroot'], unitConversions: { g: 1, piece: 100 } },
  { canonicalName: 'Bell Pepper', category: 'Vegetable',
    aliases: ['bell pepper', 'bell peppers', 'green bell pepper'], unitConversions: { g: 1, piece: 120 } },
  { canonicalName: 'Potato', category: 'Vegetable', aliases: ['potato'], unitConversions: { g: 1, piece: 150 } },
  { canonicalName: 'Green Beans', category: 'Vegetable', aliases: ['green beans'], unitConversions: { g: 1 } },
  { canonicalName: 'Green Peas', category: 'Vegetable', aliases: ['green peas'], unitConversions: { g: 1, cup: 145 } },
  { canonicalName: 'Kale', category: 'Vegetable', aliases: ['kale'], unitConversions: { g: 1, cup: 20 } },
  { canonicalName: 'Spinach', category: 'Vegetable', aliases: ['spinach'], unitConversions: { g: 1, cup: 30 } },
  { canonicalName: 'Doodhi (Bottle Gourd)', category: 'Vegetable', aliases: ['doodhi (bottle gourd)', 'bottle gourd'], unitConversions: { g: 1 } },
  { canonicalName: 'Mixed Vegetables', category: 'Vegetable', aliases: ['mixed vegetables'], unitConversions: { g: 1, cup: 150 } },

  // ── Herbs ───────────────────────────────────────────────────────────
  { canonicalName: 'Coriander Leaves', category: 'Herb',
    aliases: ['coriander leaves', 'coriander', 'cilantro'], unitConversions: { g: 1, tsp: 1.3, tbsp: 4, cup: 16 } },
  { canonicalName: 'Mint Leaves', category: 'Herb', aliases: ['mint leaves', 'mint'], unitConversions: { g: 1, cup: 12 } },
  { canonicalName: 'Curry Leaves', category: 'Herb', aliases: ['curry leaves'], unitConversions: { g: 0.3, piece: 0.3 } },
  { canonicalName: 'Rosemary', category: 'Herb', aliases: ['rosemary'], unitConversions: { g: 1, tsp: 1 } },
  { canonicalName: 'Tulsi Leaves', category: 'Herb', aliases: ['tulsi leaves'], unitConversions: { g: 0.3, piece: 0.3 } },

  // ── Spices ──────────────────────────────────────────────────────────
  { canonicalName: 'Cumin Seeds', category: 'Spice',
    aliases: ['cumin seeds', 'jeera (cumin seeds)', 'jeera (cumin)', 'cumin'], unitConversions: { g: 1, tsp: 2 } },
  { canonicalName: 'Cumin Powder', category: 'Spice', aliases: ['cumin powder'], unitConversions: { g: 1, tsp: 2 } },
  { canonicalName: 'Turmeric Powder', category: 'Spice',
    aliases: ['turmeric powder', 'turmeric'], unitConversions: { g: 1, tsp: 3 } },
  { canonicalName: 'Coriander Powder', category: 'Spice', aliases: ['coriander powder'], unitConversions: { g: 1, tsp: 2 } },
  { canonicalName: 'Coriander Seeds', category: 'Spice', aliases: ['coriander seeds'], unitConversions: { g: 1, tsp: 2 } },
  { canonicalName: 'Red Chilli Powder', category: 'Spice',
    aliases: ['red chili powder', 'red chilli powder', 'chilli powder', 'chili powder'], unitConversions: { g: 1, tsp: 2.5 } },
  { canonicalName: 'Black Pepper', category: 'Spice', aliases: ['black pepper'], unitConversions: { g: 1, tsp: 2.3 } },
  { canonicalName: 'Mustard Seeds', category: 'Spice', aliases: ['mustard seeds'], unitConversions: { g: 1, tsp: 3.2 } },
  { canonicalName: 'Fennel Seeds', category: 'Spice', aliases: ['fennel seeds'], unitConversions: { g: 1, tsp: 2 } },
  { canonicalName: 'Fenugreek Seeds', category: 'Spice', aliases: ['fenugreek seeds'], unitConversions: { g: 1, tsp: 3.7 } },
  { canonicalName: 'Cardamom', category: 'Spice', aliases: ['cardamom', 'cardamom pods'], unitConversions: { g: 1, tsp: 2, piece: 0.5 } },
  { canonicalName: 'Cinnamon Powder', category: 'Spice', aliases: ['cinnamon', 'cinnamon powder'], unitConversions: { g: 1, tsp: 2.6 } },
  { canonicalName: 'Cinnamon Stick', category: 'Spice', aliases: ['cinnamon stick'], unitConversions: { g: 2, piece: 2 } },
  { canonicalName: 'Cloves', category: 'Spice', aliases: ['cloves'], unitConversions: { g: 0.1, piece: 0.1 } },
  { canonicalName: 'Bay Leaf', category: 'Spice', aliases: ['bay leaf'], unitConversions: { g: 0.1, piece: 0.1 } },
  { canonicalName: 'Garam Masala', category: 'Spice', aliases: ['garam masala'], unitConversions: { g: 1, tsp: 2.5 } },
  { canonicalName: 'Chaat Masala', category: 'Spice', aliases: ['chaat masala'], unitConversions: { g: 1, tsp: 3 } },
  { canonicalName: 'Paprika', category: 'Spice', aliases: ['paprika'], unitConversions: { g: 1, tsp: 2.3 } },
  { canonicalName: 'Ajwain', category: 'Spice', aliases: ['ajwain'], unitConversions: { g: 1, tsp: 2.4 } },

  // ── Fruits ──────────────────────────────────────────────────────────
  { canonicalName: 'Lemon', category: 'Fruit', aliases: ['lemon', 'lemon juice'], unitConversions: { piece: 58, g: 1 } },
  { canonicalName: 'Apple', category: 'Fruit', aliases: ['apple'], unitConversions: { piece: 180 } },
  { canonicalName: 'Banana', category: 'Fruit', aliases: ['banana'], unitConversions: { piece: 120 } },
  { canonicalName: 'Avocado', category: 'Fruit', aliases: ['avocado'], unitConversions: { piece: 200 } },
  { canonicalName: 'Date', category: 'Fruit', aliases: ['date', 'dates'], unitConversions: { piece: 8 } },
  { canonicalName: 'Fig', category: 'Fruit', aliases: ['fig'], unitConversions: { piece: 50 } },
  { canonicalName: 'Pomegranate', category: 'Fruit', aliases: ['pomegranate'], unitConversions: { g: 1, piece: 280 } },
  { canonicalName: 'Tamarind', category: 'Fruit', aliases: ['tamarind'], unitConversions: { g: 1 } },
  { canonicalName: 'Raisins', category: 'Fruit', aliases: ['raisins'], unitConversions: { g: 1, tbsp: 10 } },
  { canonicalName: 'Coconut', category: 'Fruit', aliases: ['coconut'], unitConversions: { g: 1 } },
  { canonicalName: 'Mixed Fruits', category: 'Fruit', aliases: ['mixed fruits'], unitConversions: { g: 1, cup: 150 } },

  // ── Dairy ───────────────────────────────────────────────────────────
  { canonicalName: 'Curd', category: 'Dairy', aliases: ['curd'], unitConversions: { g: 1 } },
  { canonicalName: 'Low-Fat Curd', category: 'Dairy', aliases: ['low-fat curd'], unitConversions: { g: 1 } },
  { canonicalName: 'Paneer', category: 'Protein Rich', aliases: ['paneer'], unitConversions: { g: 1, tbsp: 15 } },
  { canonicalName: 'Low-Fat Paneer', category: 'Protein Rich', aliases: ['low-fat paneer'], unitConversions: { g: 1 } },
  { canonicalName: 'Milk', category: 'Dairy', aliases: ['milk'], unitConversions: { ml: 1 } },
  { canonicalName: 'Yogurt', category: 'Dairy', aliases: ['yogurt'], unitConversions: { g: 1 } },
  { canonicalName: 'Ghee', category: 'Oil/Fat', aliases: ['ghee'], unitConversions: { g: 1, tsp: 4.5 } },

  // ── Oils ────────────────────────────────────────────────────────────
  { canonicalName: 'Oil', category: 'Oil/Fat', aliases: ['oil'], unitConversions: { ml: 1, tbsp: 14, tsp: 4.5 } },
  { canonicalName: 'Olive Oil', category: 'Oil/Fat',
    aliases: ['olive oil', 'extra virgin olive oil'], unitConversions: { ml: 1, tbsp: 14, tsp: 4.5 } },

  // ── Grains / Flours / Bread ─────────────────────────────────────────
  { canonicalName: 'Rice', category: 'Grain', aliases: ['rice', 'white rice', 'jasmine rice'], unitConversions: { g: 1, cup: 190 } },
  { canonicalName: 'Basmati Rice', category: 'Grain', aliases: ['basmati rice'], unitConversions: { g: 1 } },
  { canonicalName: 'Rice Flour', category: 'Grain', aliases: ['rice flour'], unitConversions: { g: 1 } },
  { canonicalName: 'Flattened Rice', category: 'Grain', aliases: ['flattened rice'], unitConversions: { g: 1 } },
  { canonicalName: 'Quinoa', category: 'Grain', aliases: ['quinoa'], unitConversions: { g: 1, cup: 170 } },
  { canonicalName: 'Oats', category: 'Grain', aliases: ['oats', 'rolled oats'], unitConversions: { g: 1, tbsp: 6 } },
  { canonicalName: 'Whole Wheat Flour', category: 'Grain',
    aliases: ['whole wheat flour', 'whole wheat flour (atta)'], unitConversions: { g: 1 } },
  { canonicalName: 'Chickpea Flour (Besan)', category: 'Grain',
    aliases: ['besan', 'besan (chickpea flour)', 'besan (gram flour)', 'chickpea flour'],
    unitConversions: { g: 1, tbsp: 8 } },
  { canonicalName: 'Jowar Flour', category: 'Grain', aliases: ['jowar flour'], unitConversions: { g: 1 } },
  { canonicalName: 'Bajra (Pearl Millet) Flour', category: 'Grain', aliases: ['bajra (pearl millet) flour', 'bajra flour'], unitConversions: { g: 1 } },
  { canonicalName: 'Bhakri', category: 'Grain', aliases: ['bhakri'], unitConversions: { piece: 50 } },
  { canonicalName: 'Chapati', category: 'Grain', aliases: ['chapati'], unitConversions: { piece: 40 } },
  { canonicalName: 'Brown Bread', category: 'Grain', aliases: ['brown bread'], unitConversions: { piece: 28 } },
  { canonicalName: 'Whole Wheat Bread', category: 'Grain', aliases: ['whole wheat bread'], unitConversions: { piece: 28 } },
  { canonicalName: 'Baking Powder', category: 'Other', aliases: ['baking powder'], unitConversions: { g: 1, tsp: 4 } },

  // ── Legumes / Pulses ────────────────────────────────────────────────
  { canonicalName: 'Moong Dal', category: 'Legume',
    aliases: ['moong dal', 'moong dal (soaked)'], unitConversions: { g: 1, cup: 200 } },
  { canonicalName: 'Moong Beans', category: 'Legume', aliases: ['moong beans'], unitConversions: { g: 1 } },
  { canonicalName: 'Moong Sprouts', category: 'Legume', aliases: ['moong sprouts'], unitConversions: { g: 1, cup: 104 } },
  { canonicalName: 'Toor Dal', category: 'Legume', aliases: ['toor dal'], unitConversions: { g: 1, cup: 200 } },
  { canonicalName: 'Urad Dal', category: 'Legume', aliases: ['urad dal'], unitConversions: { g: 1, cup: 200 } },
  { canonicalName: 'Masoor Dal', category: 'Legume', aliases: ['masoor dal'], unitConversions: { g: 1, cup: 200 } },
  { canonicalName: 'Chickpeas', category: 'Legume', aliases: ['chickpeas'], unitConversions: { g: 1, cup: 164 } },
  { canonicalName: 'Kala Chana', category: 'Legume', aliases: ['kala chana (soaked)'], unitConversions: { g: 1 } },
  { canonicalName: 'Red Kidney Beans', category: 'Legume', aliases: ['red kidney beans', 'rajma'], unitConversions: { g: 1, cup: 177 } },
  { canonicalName: 'Black-eyed Peas', category: 'Legume', aliases: ['black-eyed peas'], unitConversions: { g: 1, cup: 172 } },
  { canonicalName: 'Matki (Moth Beans)', category: 'Legume', aliases: ['matki (moth beans)'], unitConversions: { g: 1 } },
  { canonicalName: 'Edamame', category: 'Legume', aliases: ['edamame'], unitConversions: { g: 1, cup: 155 } },
  { canonicalName: 'Roasted Chana', category: 'Legume', aliases: ['roasted chana'], unitConversions: { g: 1, tbsp: 10 } },

  // ── Protein Rich ────────────────────────────────────────────────────
  { canonicalName: 'Chicken Breast', category: 'Protein Rich', aliases: ['chicken breast'], unitConversions: { g: 1 } },
  { canonicalName: 'Chicken Leg', category: 'Protein Rich', aliases: ['chicken leg'], unitConversions: { g: 1 } },
  { canonicalName: 'Egg', category: 'Protein Rich', aliases: ['egg', 'eggs'], unitConversions: { piece: 50 } },
  { canonicalName: 'Soya Chunks', category: 'Protein Rich', aliases: ['soya chunks'], unitConversions: { g: 1, cup: 100 } },
  { canonicalName: 'Soya Flour', category: 'Protein Rich', aliases: ['soya flour'], unitConversions: { g: 1, tbsp: 8 } },
  { canonicalName: 'Mixed Sprouts', category: 'Protein Rich', aliases: ['mixed sprouts'], unitConversions: { g: 1, cup: 104 } },

  // ── Nuts / Seeds ────────────────────────────────────────────────────
  { canonicalName: 'Almonds', category: 'Nut/Seed', aliases: ['almond', 'almonds'], unitConversions: { g: 1, piece: 1.2 } },
  { canonicalName: 'Walnut', category: 'Nut/Seed', aliases: ['walnut'], unitConversions: { g: 8, piece: 8 } },
  { canonicalName: 'Peanuts', category: 'Nut/Seed', aliases: ['peanuts'], unitConversions: { g: 1, tbsp: 9 } },
  { canonicalName: 'Peanut Butter', category: 'Nut/Seed', aliases: ['peanut butter'], unitConversions: { g: 1, tbsp: 16 } },
  { canonicalName: 'Chia Seeds', category: 'Nut/Seed', aliases: ['chia seeds'], unitConversions: { g: 1, tbsp: 12 } },
  { canonicalName: 'Flaxseed', category: 'Nut/Seed', aliases: ['flaxseed'], unitConversions: { g: 1, tbsp: 10 } },
  { canonicalName: 'Sunflower Seeds', category: 'Nut/Seed', aliases: ['sunflower seeds'], unitConversions: { g: 1, tbsp: 9 } },
  { canonicalName: 'Pumpkin Seeds', category: 'Nut/Seed', aliases: ['pumpkin seeds'], unitConversions: { g: 1, tbsp: 8.5 } },
  { canonicalName: 'Makhana', category: 'Nut/Seed', aliases: ['makhana', 'foxnuts (makhana)'], unitConversions: { g: 1, cup: 14 } },

  // ── Sweeteners ──────────────────────────────────────────────────────
  { canonicalName: 'Honey', category: 'Sweetener', aliases: ['honey'], unitConversions: { g: 1, tsp: 7 } },
  { canonicalName: 'Jaggery', category: 'Sweetener', aliases: ['jaggery'], unitConversions: { g: 1 } },

  // ── Sauce/Condiment ─────────────────────────────────────────────────
  { canonicalName: 'Mustard', category: 'Sauce/Condiment', aliases: ['mustard'], unitConversions: { g: 1, tbsp: 15 } },

  // ── Other ───────────────────────────────────────────────────────────
  // Water is a liquid and every recipe records it in ml - a stray `g: 1`
  // here previously made the grocery aggregator's baseUnit heuristic
  // (`conversions.ml && !conversions.g`) pick grams over ml, showing e.g.
  // "4510g" for an ingredient no recipe ever measures in grams.
  { canonicalName: 'Water', category: 'Other', aliases: ['water', 'warm water'], unitConversions: { ml: 1 } },
  { canonicalName: 'Salt', category: 'Spice', aliases: ['salt'], unitConversions: { g: 1, tsp: 6 } },
  { canonicalName: 'Black Tea Leaves', category: 'Other', aliases: ['black tea leaves'], unitConversions: { g: 1, tsp: 2.5 } },
  // Ayurvedic herbal powder blend (amalaki/haritaki/bibhitaki) - only used
  // in Triphala Night Drink, which is being moved out of category:
  // 'Supplements' into an ordinary Night Drink recipe (see
  // fix-triphala-recipe.js), so it now needs a canonical entry like any
  // other food ingredient.
  { canonicalName: 'Triphala Churna', category: 'Other', aliases: ['triphala churna'], unitConversions: { g: 1, tsp: 5 } },

  // ── Added for fooditem-nutrition-tier1-gap-closure (74 ingredients from
  // the recipe-database-ayurveda-expansion / recipe-database-hand-authored-
  // batch-import recipes, found unresolved by scripts/audit-fooditem-
  // nutrition-coverage.js) ──────────────────────────────────────────────
  { canonicalName: 'Coconut Milk', category: 'Other', aliases: ['coconut milk'], unitConversions: { ml: 1, tbsp: 15, cup: 240 } },
  { canonicalName: 'Tapioca Pearls', category: 'Carbohydrate', aliases: ['tapioca pearls'], unitConversions: { g: 1, cup: 190 } },
  { canonicalName: 'Lettuce', category: 'Vegetable', aliases: ['lettuce'], unitConversions: { g: 1, piece: 15 } },
  { canonicalName: 'Ragi Flour', category: 'Grain', aliases: ['ragi flour'], unitConversions: { g: 1 } },
  { canonicalName: 'Sweet Corn', category: 'Vegetable', aliases: ['sweet corn', 'corn kernels', 'corn'], unitConversions: { g: 1, cup: 154 } },
  { canonicalName: 'Sweet Potato', category: 'Vegetable', aliases: ['sweet potato'], unitConversions: { g: 1, piece: 130 } },
  { canonicalName: 'Rock Salt', category: 'Spice', aliases: ['rock salt'], unitConversions: { g: 1, tsp: 5 } },
  { canonicalName: 'Black Salt', category: 'Spice', aliases: ['black salt'], unitConversions: { g: 1, tsp: 5 } },
  { canonicalName: 'Ashwagandha Powder', category: 'Spice', aliases: ['ashwagandha powder'], unitConversions: { g: 1, tsp: 3 } },
  { canonicalName: 'Nutmeg', category: 'Spice', aliases: ['nutmeg'], unitConversions: { g: 1, tsp: 2.2 } },
  { canonicalName: 'Saffron', category: 'Spice', aliases: ['saffron'], unitConversions: { g: 1, piece: 0.01 } },
  { canonicalName: 'Amla (Indian Gooseberry)', category: 'Fruit', aliases: ['amla (indian gooseberry)'], unitConversions: { g: 1, piece: 25 } },
  { canonicalName: 'Licorice Root', category: 'Spice', aliases: ['licorice root'], unitConversions: { g: 1, tsp: 3 } },
  { canonicalName: 'Sugar', category: 'Sweetener', aliases: ['sugar'], unitConversions: { g: 1, tsp: 4.2, tbsp: 12.5 } },
  { canonicalName: 'Red Onion', category: 'Vegetable', aliases: ['red onion'], unitConversions: { g: 1, piece: 110 } },
  { canonicalName: 'Olives', category: 'Vegetable', aliases: ['olives'], unitConversions: { g: 1, piece: 4 } },
  { canonicalName: 'Parsley', category: 'Herb', aliases: ['parsley'], unitConversions: { g: 1, tbsp: 3.8 } },
  { canonicalName: 'Couscous', category: 'Grain', aliases: ['couscous'], unitConversions: { g: 1, cup: 173 } },
  { canonicalName: 'Broccoli', category: 'Vegetable', aliases: ['broccoli'], unitConversions: { g: 1, cup: 91 } },
  { canonicalName: 'Thai Red Curry Paste', category: 'Sauce/Condiment', aliases: ['thai red curry paste'], unitConversions: { g: 1, tbsp: 17 } },
  { canonicalName: 'Basil Leaves', category: 'Herb', aliases: ['basil leaves'], unitConversions: { g: 1, piece: 0.5, tbsp: 2.4 } },
  { canonicalName: 'Lime', category: 'Fruit', aliases: ['lime'], unitConversions: { g: 1, piece: 67 } },
  { canonicalName: 'Black Beans', category: 'Legume', aliases: ['black beans'], unitConversions: { g: 1, cup: 194 } },
  { canonicalName: 'Brown Rice', category: 'Grain', aliases: ['brown rice'], unitConversions: { g: 1, cup: 190 } },
  { canonicalName: 'Tahini', category: 'Sauce/Condiment', aliases: ['tahini'], unitConversions: { g: 1, tbsp: 15 } },
  { canonicalName: 'Whole Wheat Pita', category: 'Grain', aliases: ['whole wheat pita'], unitConversions: { g: 1, piece: 60 } },
  { canonicalName: 'Miso Paste', category: 'Sauce/Condiment', aliases: ['miso paste'], unitConversions: { g: 1, tbsp: 17 } },
  { canonicalName: 'Tofu', category: 'Protein Rich', aliases: ['tofu'], unitConversions: { g: 1 } },
  { canonicalName: 'Spring Onion', category: 'Vegetable', aliases: ['spring onion'], unitConversions: { g: 1, piece: 15 } },
  { canonicalName: 'Soy Sauce', category: 'Sauce/Condiment', aliases: ['soy sauce'], unitConversions: { ml: 1, tbsp: 16 } },
  { canonicalName: 'Sesame Oil', category: 'Oil/Fat', aliases: ['sesame oil'], unitConversions: { ml: 1, tsp: 4.5, tbsp: 14 } },
  { canonicalName: 'Zucchini', category: 'Vegetable', aliases: ['zucchini'], unitConversions: { g: 1, piece: 200 } },
  { canonicalName: 'Mushroom', category: 'Vegetable', aliases: ['mushroom'], unitConversions: { g: 1, piece: 18 } },
  { canonicalName: 'Thyme', category: 'Herb', aliases: ['thyme'], unitConversions: { g: 1, tsp: 1 } },
  { canonicalName: 'Amla Juice', category: 'Other', aliases: ['amla juice'], unitConversions: { ml: 1 } },
  { canonicalName: 'Kokum', category: 'Fruit', aliases: ['kokum'], unitConversions: { g: 1, piece: 3 } },
  { canonicalName: 'Lemongrass', category: 'Herb', aliases: ['lemongrass'], unitConversions: { g: 1, piece: 10 } },
  { canonicalName: 'Moringa Leaves', category: 'Herb', aliases: ['moringa leaves'], unitConversions: { g: 1, piece: 0.5 } },
  { canonicalName: 'Basil Seeds', category: 'Nut/Seed', aliases: ['basil seeds'], unitConversions: { g: 1, tsp: 4 } },
  { canonicalName: 'Wheatgrass Juice', category: 'Other', aliases: ['wheatgrass juice'], unitConversions: { ml: 1 } },
  { canonicalName: 'Semolina', category: 'Grain', aliases: ['semolina'], unitConversions: { g: 1, cup: 167 } },
  { canonicalName: 'Fenugreek Leaves', category: 'Vegetable', aliases: ['fenugreek leaves'], unitConversions: { g: 1, cup: 38 } },
  { canonicalName: 'Broken Wheat', category: 'Grain', aliases: ['broken wheat'], unitConversions: { g: 1, cup: 170 } },
  { canonicalName: 'Sesame Seeds', category: 'Nut/Seed', aliases: ['sesame seeds'], unitConversions: { g: 1, tsp: 3, tbsp: 9 } },
  { canonicalName: 'Chana Dal', category: 'Legume', aliases: ['chana dal'], unitConversions: { g: 1, cup: 200 } },
  { canonicalName: 'Red Chilli', category: 'Vegetable', aliases: ['red chilli', 'red chili'], unitConversions: { g: 1, piece: 5 } },
  { canonicalName: 'Dried Cranberries', category: 'Fruit', aliases: ['dried cranberries'], unitConversions: { g: 1 } },
  { canonicalName: 'Puffed Rice', category: 'Grain', aliases: ['puffed rice'], unitConversions: { g: 1, cup: 28 } },
  { canonicalName: 'Watermelon', category: 'Fruit', aliases: ['watermelon'], unitConversions: { g: 1 } },
  { canonicalName: 'Okra', category: 'Vegetable', aliases: ['okra'], unitConversions: { g: 1 } },
  { canonicalName: 'Fish', category: 'Protein Rich', aliases: ['fish'], unitConversions: { g: 1 } },
  { canonicalName: 'Whole Masoor Dal', category: 'Legume', aliases: ['whole masoor dal'], unitConversions: { g: 1, cup: 198 } },
  { canonicalName: 'Cashews', category: 'Nut/Seed', aliases: ['cashews'], unitConversions: { g: 1, piece: 1.5 } },
  { canonicalName: 'Pav Bhaji Masala', category: 'Spice', aliases: ['pav bhaji masala'], unitConversions: { g: 1, tsp: 3 } },
  { canonicalName: 'Brinjal', category: 'Vegetable', aliases: ['brinjal'], unitConversions: { g: 1, piece: 250 } },
  { canonicalName: 'Green Tea Leaves', category: 'Herb', aliases: ['green tea leaves'], unitConversions: { g: 1, tsp: 2 } },
  { canonicalName: 'Papad', category: 'Other', aliases: ['papad'], unitConversions: { piece: 15 } },
  { canonicalName: 'Jowar', category: 'Grain', aliases: ['jowar'], unitConversions: { g: 1 } },
  { canonicalName: 'Ridge Gourd', category: 'Vegetable', aliases: ['ridge gourd'], unitConversions: { g: 1 } },
  { canonicalName: 'Bajra', category: 'Grain', aliases: ['bajra'], unitConversions: { g: 1 } },
  { canonicalName: 'Chamomile Flowers', category: 'Herb', aliases: ['chamomile flowers', 'dried chamomile flowers'], unitConversions: { g: 1, tsp: 1 } },
  { canonicalName: 'Shatavari Powder', category: 'Spice', aliases: ['shatavari powder'], unitConversions: { g: 1, tsp: 3 } },
  { canonicalName: 'Almond Milk', category: 'Other', aliases: ['almond milk'], unitConversions: { ml: 1 } },
  { canonicalName: 'Brahmi', category: 'Herb', aliases: ['brahmi'], unitConversions: { g: 1, tsp: 2 } },
  { canonicalName: 'Shankhpushpi', category: 'Herb', aliases: ['shankhpushpi'], unitConversions: { g: 1, tsp: 2 } },
];

// Every German term found across all 11 currently-translated supplements'
// supplementFacts (nutrients[].name and servingSize.label), confirmed by
// re-dumping the live DB before finalizing this table (see the migration
// script's self-check, which flags anything not covered here rather than
// trusting this list blindly). International/scientific abbreviations
// (µg RE, mg α-TE, mg NE, x10^9 AFU) are NOT German and are left as-is.
const GERMAN_SUPPLEMENT_TRANSLATIONS = {
  // nutrients[].name
  'Energie': 'Energy',
  'Fett': 'Fat',
  'davon gesättigte Fettsäuren': 'of which saturates',
  'Kohlenhydrate': 'Carbohydrates',
  'davon Zucker': 'of which sugars',
  'Eiweiß': 'Protein',
  'Salz': 'Salt',
  'Folsäure': 'Folic Acid',
  'Eisen': 'Iron',
  'Zink': 'Zinc',
  'Kupfer': 'Copper',
  'Selen': 'Selenium',
  'Chrom': 'Chromium',
  'Molybdän': 'Molybdenum',
  'Jod': 'Iodine',
  'Pantothensäure': 'Pantothenic Acid',
  'Phosphor': 'Phosphorus',
  'Milchsäurebakterien': 'Lactic Acid Bacteria',
  'L-Histidin': 'L-Histidine',
  'L-Cystein': 'L-Cysteine',
  'Fischölkonzentrat aus Seefischöl': 'Fish Oil Concentrate (Marine Fish Oil)',
  'Omega-3-Fettsäuren insgesamt': 'Total Omega-3 Fatty Acids',
  'Eicosapentaensäure (EPA)': 'Eicosapentaenoic Acid (EPA)',
  'Docosahexaensäure (DHA)': 'Docosahexaenoic Acid (DHA)',
  // servingSize.label
  '1 Tablette': '1 tablet',
  '1 Kapsel': '1 capsule',
  '~3 g Triphala-Pulver in warmem Wasser': '~3g Triphala powder in warm water',
  '1 Messlöffel (25 g)': '1 scoop (25g)',
  '1 Tablette (= dnevna doza)': '1 tablet (daily dose)',
};

/**
 * Resolves a raw ingredient name string to its canonical entry.
 * Normalize-first-pass (trim+lowercase) against every alias, then against
 * every canonicalName itself (so already-correct entries no-op). Returns
 * null - never guesses - if truly unrecognized, so a genuinely new future
 * variant surfaces as UNRESOLVED in the migration script's dry-run output
 * for a human to add one table line, rather than being silently
 * fuzzy-matched (which risks merging two different real ingredients).
 */
function resolveCanonical(rawName) {
  const key = (rawName || '').trim().toLowerCase();
  if (!key) return null;
  for (const entry of CANONICAL_INGREDIENTS) {
    if (entry.aliases.includes(key)) return entry;
    if (entry.canonicalName.trim().toLowerCase() === key) return entry;
  }
  return null;
}

module.exports = { CANONICAL_INGREDIENTS, GERMAN_SUPPLEMENT_TRANSLATIONS, resolveCanonical };
