/**
 * v4.0 Phase 0's Tier-1 nutrition seed table - the "prerequisite complete"
 * data for services/recipeVersioningService.js to compute real per-
 * ingredient nutrition instead of flagging hasUnresolvedIngredients.
 *
 * Keyed by the SAME canonical names as scripts/canonical-ingredients-data.js
 * (CANONICAL_INGREDIENTS) - confirmed via scripts/report-ingredient-frequency.js
 * run against this dietician's real 79-recipe corpus that every one of its
 * 111 distinct ingredient names is already an exact canonical spelling (not
 * a raw alias), meaning migrate-canonical-ingredients.js has already run on
 * this data and a simple normalize(canonicalName) match against
 * FoodItem.normalizedName resolves the real corpus directly - see
 * scripts/seed-food-item-nutrition.js, which joins this table against
 * CANONICAL_INGREDIENTS for category/unitConversions and writes one
 * FoodItem per entry.
 *
 * Values are per-100g, hand-compiled from standard IFCT (Indian Food
 * Composition Tables)/USDA-style reference figures - typical/average
 * figures for the named ingredient in its ordinarily-measured form (raw for
 * a raw vegetable/fruit/nut/dry grain or legume a recipe adds by weight
 * before cooking; as-eaten for a prepared item like bread/chapati/bhakri
 * that's never separately weighed raw). APPROXIMATE, same caveat
 * canonical-ingredients-data.js's own unitConversions carry - not lab-
 * tested per batch, a real-world ingredient's actual values vary by
 * variety/growing conditions/brand. Good enough for diet-plan-level
 * calorie/macro guidance, not a clinical lab reference.
 *
 * dataSource is always 'tier1-seed' here (see models/FoodItem.js) - any
 * ingredient added later via the Tier-2 dietician-facing entry form gets
 * 'dietician-entered' instead, at write time, not here.
 */

const FOOD_ITEM_NUTRITION_DATA = {
  // ── Vegetables ──────────────────────────────────────────────────────
  Onion: { calories: 40, protein: 1.1, carbs: 9.3, fats: 0.1, fiber: 1.7 },
  Tomato: { calories: 18, protein: 0.9, carbs: 3.9, fats: 0.2, fiber: 1.2 },
  Garlic: { calories: 149, protein: 6.4, carbs: 33.1, fats: 0.5, fiber: 2.1 },
  Ginger: { calories: 80, protein: 1.8, carbs: 17.8, fats: 0.8, fiber: 2.0 },
  'Green Chilli': { calories: 40, protein: 2.0, carbs: 9.0, fats: 0.2, fiber: 1.5 },
  Carrot: { calories: 41, protein: 0.9, carbs: 9.6, fats: 0.2, fiber: 2.8 },
  Cauliflower: { calories: 25, protein: 1.9, carbs: 5.0, fats: 0.3, fiber: 2.0 },
  Cucumber: { calories: 15, protein: 0.7, carbs: 3.6, fats: 0.1, fiber: 0.5 },
  Beetroot: { calories: 43, protein: 1.6, carbs: 9.6, fats: 0.2, fiber: 2.8 },
  'Bell Pepper': { calories: 31, protein: 1.0, carbs: 6.0, fats: 0.3, fiber: 2.1 },
  Potato: { calories: 77, protein: 2.0, carbs: 17.5, fats: 0.1, fiber: 2.2 },
  'Green Beans': { calories: 31, protein: 1.8, carbs: 7.0, fats: 0.2, fiber: 3.4 },
  'Green Peas': { calories: 81, protein: 5.4, carbs: 14.5, fats: 0.4, fiber: 5.7 },
  Kale: { calories: 49, protein: 4.3, carbs: 8.8, fats: 0.9, fiber: 3.6 },
  Spinach: { calories: 23, protein: 2.9, carbs: 3.6, fats: 0.4, fiber: 2.2 },
  'Doodhi (Bottle Gourd)': { calories: 14, protein: 0.6, carbs: 3.4, fats: 0.02, fiber: 1.2 },
  'Mixed Vegetables': { calories: 65, protein: 2.5, carbs: 12.0, fats: 0.5, fiber: 3.5 },

  // ── Herbs ───────────────────────────────────────────────────────────
  'Coriander Leaves': { calories: 23, protein: 2.1, carbs: 3.7, fats: 0.5, fiber: 2.8 },
  'Mint Leaves': { calories: 44, protein: 3.8, carbs: 8.4, fats: 0.7, fiber: 6.8 },
  'Curry Leaves': { calories: 108, protein: 6.1, carbs: 18.7, fats: 1.0, fiber: 6.4 },
  Rosemary: { calories: 131, protein: 3.3, carbs: 20.7, fats: 5.9, fiber: 14.1 },
  'Tulsi Leaves': { calories: 22, protein: 3.2, carbs: 2.7, fats: 0.6, fiber: 1.6 },

  // ── Spices ──────────────────────────────────────────────────────────
  'Cumin Seeds': { calories: 375, protein: 17.8, carbs: 44.2, fats: 22.3, fiber: 10.5 },
  'Cumin Powder': { calories: 375, protein: 17.8, carbs: 44.2, fats: 22.3, fiber: 10.5 },
  'Turmeric Powder': { calories: 312, protein: 9.7, carbs: 67.1, fats: 3.2, fiber: 22.7 },
  'Coriander Powder': { calories: 298, protein: 12.4, carbs: 55.0, fats: 17.8, fiber: 41.9 },
  'Coriander Seeds': { calories: 298, protein: 12.4, carbs: 55.0, fats: 17.8, fiber: 41.9 },
  'Red Chilli Powder': { calories: 282, protein: 12.9, carbs: 49.7, fats: 14.3, fiber: 28.7 },
  'Black Pepper': { calories: 251, protein: 10.4, carbs: 63.9, fats: 3.3, fiber: 25.3 },
  'Mustard Seeds': { calories: 508, protein: 26.1, carbs: 28.1, fats: 36.2, fiber: 12.2 },
  'Fennel Seeds': { calories: 345, protein: 15.8, carbs: 52.3, fats: 14.9, fiber: 39.8 },
  'Fenugreek Seeds': { calories: 323, protein: 23.0, carbs: 58.4, fats: 6.4, fiber: 24.6 },
  Cardamom: { calories: 311, protein: 10.8, carbs: 68.5, fats: 6.7, fiber: 28.0 },
  'Cinnamon Powder': { calories: 247, protein: 4.0, carbs: 80.6, fats: 1.2, fiber: 53.1 },
  'Cinnamon Stick': { calories: 247, protein: 4.0, carbs: 80.6, fats: 1.2, fiber: 53.1 },
  Cloves: { calories: 274, protein: 6.0, carbs: 65.5, fats: 13.0, fiber: 33.9 },
  'Bay Leaf': { calories: 313, protein: 7.6, carbs: 75.0, fats: 8.4, fiber: 26.3 },
  'Garam Masala': { calories: 379, protein: 15.0, carbs: 51.0, fats: 15.0, fiber: 30.0 },
  'Chaat Masala': { calories: 250, protein: 8.0, carbs: 55.0, fats: 5.0, fiber: 20.0 },
  Paprika: { calories: 282, protein: 14.1, carbs: 53.9, fats: 12.9, fiber: 34.9 },
  Ajwain: { calories: 305, protein: 15.9, carbs: 44.3, fats: 25.0, fiber: 21.2 },

  // ── Fruits ──────────────────────────────────────────────────────────
  Lemon: { calories: 29, protein: 1.1, carbs: 9.3, fats: 0.3, fiber: 2.8 },
  Apple: { calories: 52, protein: 0.3, carbs: 13.8, fats: 0.2, fiber: 2.4 },
  Banana: { calories: 89, protein: 1.1, carbs: 22.8, fats: 0.3, fiber: 2.6 },
  Avocado: { calories: 160, protein: 2.0, carbs: 8.5, fats: 14.7, fiber: 6.7 },
  Date: { calories: 277, protein: 1.8, carbs: 75.0, fats: 0.2, fiber: 6.7 },
  Fig: { calories: 74, protein: 0.8, carbs: 19.2, fats: 0.3, fiber: 2.9 },
  Pomegranate: { calories: 83, protein: 1.7, carbs: 18.7, fats: 1.2, fiber: 4.0 },
  Tamarind: { calories: 239, protein: 2.8, carbs: 62.5, fats: 0.6, fiber: 5.1 },
  Raisins: { calories: 299, protein: 3.1, carbs: 79.2, fats: 0.5, fiber: 3.7 },
  Coconut: { calories: 354, protein: 3.3, carbs: 15.2, fats: 33.5, fiber: 9.0 },
  'Mixed Fruits': { calories: 60, protein: 0.8, carbs: 15.0, fats: 0.3, fiber: 2.0 },

  // ── Dairy ───────────────────────────────────────────────────────────
  Curd: { calories: 61, protein: 3.5, carbs: 4.7, fats: 3.3, fiber: 0 },
  'Low-Fat Curd': { calories: 56, protein: 4.3, carbs: 5.0, fats: 1.5, fiber: 0 },
  Paneer: { calories: 265, protein: 18.3, carbs: 1.2, fats: 20.8, fiber: 0 },
  'Low-Fat Paneer': { calories: 180, protein: 22.0, carbs: 3.0, fats: 9.0, fiber: 0 },
  Milk: { calories: 61, protein: 3.2, carbs: 4.8, fats: 3.3, fiber: 0 },
  Yogurt: { calories: 61, protein: 3.5, carbs: 4.7, fats: 3.3, fiber: 0 },
  Ghee: { calories: 900, protein: 0, carbs: 0, fats: 100, fiber: 0 },

  // ── Oils ────────────────────────────────────────────────────────────
  Oil: { calories: 884, protein: 0, carbs: 0, fats: 100, fiber: 0 },
  'Olive Oil': { calories: 884, protein: 0, carbs: 0, fats: 100, fiber: 0 },

  // ── Grains / Flours / Bread ─────────────────────────────────────────
  Rice: { calories: 365, protein: 7.1, carbs: 80.0, fats: 0.7, fiber: 1.3 },
  'Basmati Rice': { calories: 349, protein: 8.0, carbs: 77.0, fats: 0.5, fiber: 1.0 },
  'Rice Flour': { calories: 366, protein: 6.0, carbs: 80.1, fats: 1.4, fiber: 2.4 },
  'Flattened Rice': { calories: 356, protein: 6.6, carbs: 76.9, fats: 1.2, fiber: 2.3 },
  Quinoa: { calories: 368, protein: 14.1, carbs: 64.2, fats: 6.1, fiber: 7.0 },
  Oats: { calories: 389, protein: 16.9, carbs: 66.3, fats: 6.9, fiber: 10.6 },
  'Whole Wheat Flour': { calories: 340, protein: 13.2, carbs: 72.0, fats: 2.5, fiber: 12.2 },
  'Chickpea Flour (Besan)': { calories: 387, protein: 22.4, carbs: 57.8, fats: 6.7, fiber: 10.8 },
  'Jowar Flour': { calories: 349, protein: 10.4, carbs: 72.6, fats: 3.3, fiber: 6.7 },
  'Bajra (Pearl Millet) Flour': { calories: 361, protein: 11.6, carbs: 67.5, fats: 5.0, fiber: 11.3 },
  Bhakri: { calories: 350, protein: 9.0, carbs: 70.0, fats: 4.0, fiber: 6.0 },
  Chapati: { calories: 297, protein: 11.0, carbs: 46.0, fats: 7.3, fiber: 8.0 },
  'Brown Bread': { calories: 246, protein: 9.0, carbs: 41.0, fats: 3.4, fiber: 6.9 },
  'Whole Wheat Bread': { calories: 247, protein: 13.0, carbs: 41.0, fats: 3.4, fiber: 7.0 },
  'Baking Powder': { calories: 53, protein: 0, carbs: 27.7, fats: 0, fiber: 0.2 },

  // ── Legumes / Pulses (raw/dry, except sprouts) ─────────────────────
  'Moong Dal': { calories: 347, protein: 24.0, carbs: 63.0, fats: 1.2, fiber: 16.3 },
  'Moong Beans': { calories: 347, protein: 23.9, carbs: 62.6, fats: 1.2, fiber: 16.3 },
  'Moong Sprouts': { calories: 30, protein: 3.0, carbs: 6.2, fats: 0.2, fiber: 1.8 },
  'Toor Dal': { calories: 335, protein: 22.3, carbs: 57.6, fats: 1.5, fiber: 15.5 },
  'Urad Dal': { calories: 341, protein: 25.2, carbs: 58.9, fats: 1.6, fiber: 18.3 },
  'Masoor Dal': { calories: 352, protein: 25.0, carbs: 60.0, fats: 1.1, fiber: 11.0 },
  Chickpeas: { calories: 364, protein: 19.3, carbs: 61.0, fats: 6.0, fiber: 17.4 },
  'Kala Chana': { calories: 364, protein: 19.3, carbs: 61.0, fats: 6.0, fiber: 17.4 },
  'Red Kidney Beans': { calories: 333, protein: 24.4, carbs: 60.0, fats: 0.8, fiber: 15.2 },
  'Black-eyed Peas': { calories: 336, protein: 23.5, carbs: 60.0, fats: 1.3, fiber: 10.6 },
  'Matki (Moth Beans)': { calories: 343, protein: 23.6, carbs: 61.5, fats: 1.6, fiber: 16.0 },
  Edamame: { calories: 122, protein: 11.9, carbs: 10.0, fats: 5.2, fiber: 5.2 },
  'Roasted Chana': { calories: 364, protein: 20.5, carbs: 60.0, fats: 5.4, fiber: 17.3 },

  // ── Protein Rich ────────────────────────────────────────────────────
  'Chicken Breast': { calories: 120, protein: 22.5, carbs: 0, fats: 2.6, fiber: 0 },
  'Chicken Leg': { calories: 119, protein: 20.6, carbs: 0, fats: 3.5, fiber: 0 },
  Egg: { calories: 155, protein: 13.0, carbs: 1.1, fats: 11.0, fiber: 0 },
  'Soya Chunks': { calories: 345, protein: 52.0, carbs: 33.0, fats: 0.5, fiber: 13.0 },
  'Soya Flour': { calories: 436, protein: 34.5, carbs: 30.4, fats: 20.6, fiber: 9.6 },
  'Mixed Sprouts': { calories: 30, protein: 3.0, carbs: 6.0, fats: 0.2, fiber: 1.8 },

  // ── Nuts / Seeds ────────────────────────────────────────────────────
  Almonds: { calories: 579, protein: 21.2, carbs: 21.6, fats: 49.9, fiber: 12.5 },
  Walnut: { calories: 654, protein: 15.2, carbs: 13.7, fats: 65.2, fiber: 6.7 },
  Peanuts: { calories: 567, protein: 25.8, carbs: 16.1, fats: 49.2, fiber: 8.5 },
  'Peanut Butter': { calories: 588, protein: 25.0, carbs: 20.0, fats: 50.0, fiber: 6.0 },
  'Chia Seeds': { calories: 486, protein: 16.5, carbs: 42.1, fats: 30.7, fiber: 34.4 },
  Flaxseed: { calories: 534, protein: 18.3, carbs: 28.9, fats: 42.2, fiber: 27.3 },
  'Sunflower Seeds': { calories: 584, protein: 20.8, carbs: 20.0, fats: 51.5, fiber: 8.6 },
  'Pumpkin Seeds': { calories: 559, protein: 30.2, carbs: 10.7, fats: 49.0, fiber: 6.0 },
  Makhana: { calories: 347, protein: 9.7, carbs: 76.9, fats: 0.1, fiber: 14.5 },

  // ── Sweeteners ──────────────────────────────────────────────────────
  Honey: { calories: 304, protein: 0.3, carbs: 82.4, fats: 0, fiber: 0.2 },
  Jaggery: { calories: 383, protein: 0.4, carbs: 98.0, fats: 0.1, fiber: 0 },

  // ── Sauce/Condiment ─────────────────────────────────────────────────
  Mustard: { calories: 66, protein: 4.4, carbs: 5.8, fats: 3.3, fiber: 3.3 },

  // ── Other ───────────────────────────────────────────────────────────
  Water: { calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0 },
  Salt: { calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0 },
  'Black Tea Leaves': { calories: 1, protein: 0, carbs: 0.3, fats: 0, fiber: 0 },
  'Triphala Churna': { calories: 300, protein: 3.0, carbs: 70.0, fats: 1.0, fiber: 25.0 },

  // ── Added for fooditem-nutrition-tier1-gap-closure ─────────────────
  'Coconut Milk': { calories: 230, protein: 2.3, carbs: 5.5, fats: 23.8, fiber: 2.2 },
  'Tapioca Pearls': { calories: 358, protein: 0.2, carbs: 88.7, fats: 0.02, fiber: 0.9 },
  Lettuce: { calories: 15, protein: 1.4, carbs: 2.9, fats: 0.2, fiber: 1.3 },
  'Ragi Flour': { calories: 336, protein: 7.3, carbs: 72.0, fats: 1.3, fiber: 11.5 },
  'Sweet Corn': { calories: 86, protein: 3.2, carbs: 19.0, fats: 1.2, fiber: 2.7 },
  'Sweet Potato': { calories: 86, protein: 1.6, carbs: 20.1, fats: 0.1, fiber: 3.0 },
  'Rock Salt': { calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0 },
  'Black Salt': { calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0 },
  'Ashwagandha Powder': { calories: 245, protein: 3.9, carbs: 49.9, fats: 0.3, fiber: 32.3 },
  Nutmeg: { calories: 525, protein: 5.8, carbs: 49.3, fats: 36.3, fiber: 20.8 },
  Saffron: { calories: 310, protein: 11.4, carbs: 65.4, fats: 5.9, fiber: 3.9 },
  'Amla (Indian Gooseberry)': { calories: 58, protein: 0.9, carbs: 13.7, fats: 0.6, fiber: 4.3 },
  'Licorice Root': { calories: 375, protein: 3.3, carbs: 65.0, fats: 1.1, fiber: 30.0 },
  Sugar: { calories: 387, protein: 0, carbs: 100.0, fats: 0, fiber: 0 },
  'Red Onion': { calories: 40, protein: 1.1, carbs: 9.3, fats: 0.1, fiber: 1.7 },
  Olives: { calories: 115, protein: 0.8, carbs: 6.3, fats: 10.7, fiber: 3.2 },
  Parsley: { calories: 36, protein: 3.0, carbs: 6.3, fats: 0.8, fiber: 3.3 },
  Couscous: { calories: 376, protein: 12.8, carbs: 77.4, fats: 0.6, fiber: 5.0 },
  Broccoli: { calories: 34, protein: 2.8, carbs: 6.6, fats: 0.4, fiber: 2.6 },
  'Thai Red Curry Paste': { calories: 132, protein: 3.0, carbs: 15.0, fats: 6.5, fiber: 3.0 },
  'Basil Leaves': { calories: 23, protein: 3.2, carbs: 2.6, fats: 0.6, fiber: 1.6 },
  Lime: { calories: 30, protein: 0.7, carbs: 10.5, fats: 0.2, fiber: 2.8 },
  'Black Beans': { calories: 341, protein: 21.6, carbs: 62.4, fats: 1.4, fiber: 15.5 },
  'Brown Rice': { calories: 370, protein: 7.9, carbs: 77.2, fats: 2.9, fiber: 3.5 },
  Tahini: { calories: 595, protein: 17.0, carbs: 21.0, fats: 53.8, fiber: 9.3 },
  'Whole Wheat Pita': { calories: 247, protein: 10.7, carbs: 49.0, fats: 1.7, fiber: 6.4 },
  'Miso Paste': { calories: 199, protein: 12.8, carbs: 26.5, fats: 6.0, fiber: 5.4 },
  Tofu: { calories: 76, protein: 8.1, carbs: 1.9, fats: 4.8, fiber: 0.3 },
  'Spring Onion': { calories: 32, protein: 1.8, carbs: 7.3, fats: 0.2, fiber: 2.6 },
  'Soy Sauce': { calories: 53, protein: 8.1, carbs: 4.9, fats: 0.1, fiber: 0.8 },
  'Sesame Oil': { calories: 884, protein: 0, carbs: 0, fats: 100.0, fiber: 0 },
  Zucchini: { calories: 17, protein: 1.2, carbs: 3.1, fats: 0.3, fiber: 1.0 },
  Mushroom: { calories: 22, protein: 3.1, carbs: 3.3, fats: 0.3, fiber: 1.0 },
  Thyme: { calories: 101, protein: 5.6, carbs: 24.5, fats: 1.7, fiber: 14.0 },
  'Amla Juice': { calories: 30, protein: 0.3, carbs: 7.0, fats: 0.1, fiber: 0.5 },
  Kokum: { calories: 66, protein: 1.0, carbs: 15.0, fats: 0.5, fiber: 3.0 },
  Lemongrass: { calories: 99, protein: 1.8, carbs: 25.3, fats: 0.5, fiber: 0 },
  'Moringa Leaves': { calories: 64, protein: 9.4, carbs: 8.3, fats: 1.4, fiber: 2.0 },
  'Basil Seeds': { calories: 409, protein: 14.0, carbs: 61.0, fats: 16.0, fiber: 24.0 },
  'Wheatgrass Juice': { calories: 25, protein: 2.0, carbs: 4.5, fats: 0.3, fiber: 1.0 },
  Semolina: { calories: 360, protein: 12.7, carbs: 72.8, fats: 1.1, fiber: 3.9 },
  'Fenugreek Leaves': { calories: 49, protein: 4.4, carbs: 6.0, fats: 0.9, fiber: 4.0 },
  'Broken Wheat': { calories: 342, protein: 12.0, carbs: 71.0, fats: 1.5, fiber: 12.5 },
  'Sesame Seeds': { calories: 573, protein: 17.7, carbs: 23.4, fats: 49.7, fiber: 11.8 },
  'Chana Dal': { calories: 364, protein: 20.8, carbs: 61.0, fats: 5.3, fiber: 17.1 },
  'Red Chilli': { calories: 40, protein: 2.0, carbs: 9.0, fats: 0.4, fiber: 1.5 },
  'Dried Cranberries': { calories: 308, protein: 0.1, carbs: 82.4, fats: 1.1, fiber: 5.3 },
  'Puffed Rice': { calories: 387, protein: 7.5, carbs: 87.0, fats: 0.6, fiber: 1.4 },
  Watermelon: { calories: 30, protein: 0.6, carbs: 7.6, fats: 0.2, fiber: 0.4 },
  Okra: { calories: 33, protein: 1.9, carbs: 7.5, fats: 0.2, fiber: 3.2 },
  Fish: { calories: 105, protein: 20.0, carbs: 0, fats: 2.5, fiber: 0 },
  'Whole Masoor Dal': { calories: 336, protein: 24.3, carbs: 60.1, fats: 1.1, fiber: 10.7 },
  Cashews: { calories: 553, protein: 18.2, carbs: 30.2, fats: 43.9, fiber: 3.3 },
  'Pav Bhaji Masala': { calories: 325, protein: 10.0, carbs: 55.0, fats: 8.0, fiber: 20.0 },
  Brinjal: { calories: 25, protein: 1.0, carbs: 5.9, fats: 0.2, fiber: 3.0 },
  'Green Tea Leaves': { calories: 1, protein: 0, carbs: 0, fats: 0, fiber: 0 },
  Papad: { calories: 370, protein: 24.0, carbs: 60.0, fats: 3.0, fiber: 6.0 },
  Jowar: { calories: 349, protein: 10.4, carbs: 72.6, fats: 3.1, fiber: 6.7 },
  'Ridge Gourd': { calories: 20, protein: 1.2, carbs: 4.4, fats: 0.1, fiber: 1.6 },
  Bajra: { calories: 361, protein: 11.6, carbs: 67.5, fats: 5.0, fiber: 1.2 },
  'Chamomile Flowers': { calories: 1, protein: 0, carbs: 0.2, fats: 0, fiber: 0 },
  'Shatavari Powder': { calories: 245, protein: 4.0, carbs: 49.0, fats: 1.0, fiber: 30.0 },
  'Almond Milk': { calories: 15, protein: 0.6, carbs: 0.6, fats: 1.2, fiber: 0.3 },
  Brahmi: { calories: 200, protein: 4.0, carbs: 40.0, fats: 1.0, fiber: 20.0 },
  Shankhpushpi: { calories: 200, protein: 4.0, carbs: 40.0, fats: 1.0, fiber: 20.0 },
};

module.exports = { FOOD_ITEM_NUTRITION_DATA };
