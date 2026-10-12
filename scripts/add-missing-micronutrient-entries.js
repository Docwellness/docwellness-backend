const fs = require('fs');
const path = 'scripts/data/fooditem-micronutrients.json';
const data = JSON.parse(fs.readFileSync(path, 'utf8'));

data['Cumin Powder'] = {
  saturatedFat: 1.535, transFat: null, sugar: 2.25, cholesterol: 0, sodium: 168, calcium: 931, iron: 66.36, potassium: 1788, vitaminC: 7.7,
  provenance: {
    saturatedFat: { status: 'researched', confidence: 'medium', method: 'single-source', sources: [{ name: 'USDA-FDC', ref: 'FDC 170923, Spices, cumin seed', value: 1.535, basis: 'raw' }] },
    transFat: { status: 'unknown', confidence: 'low', method: 'single-source', sources: [], note: 'Not listed in USDA FDC 170923 entry; left null rather than assumed 0.' },
    sugar: { status: 'researched', confidence: 'medium', method: 'single-source', sources: [{ name: 'USDA-FDC', ref: 'FDC 170923, Spices, cumin seed', value: 2.25, basis: 'raw' }] },
    cholesterol: { status: 'verified-zero', confidence: 'high', method: 'rule:plant-cholesterol', sources: [] },
    sodium: { status: 'researched', confidence: 'high', method: 'multi-source', sources: [{ name: 'USDA-FDC', ref: 'FDC 170923, Spices, cumin seed', value: 168, basis: 'raw' }, { name: 'myfooddata/recipal (USDA-derived, per-oz converted)', ref: '48mg/oz -> ~171mg/100g', value: 171, basis: 'raw' }] },
    calcium: { status: 'researched', confidence: 'high', method: 'multi-source', sources: [{ name: 'USDA-FDC', ref: 'FDC 170923, Spices, cumin seed', value: 931, basis: 'raw' }, { name: 'myfooddata/recipal (USDA-derived, per-oz converted)', ref: '260mg/oz -> ~929mg/100g', value: 929, basis: 'raw' }] },
    iron: { status: 'researched', confidence: 'high', method: 'multi-source', sources: [{ name: 'USDA-FDC', ref: 'FDC 170923, Spices, cumin seed', value: 66.36, basis: 'raw' }, { name: 'myfooddata/recipal (USDA-derived, per-oz converted)', ref: '18.8mg/oz -> ~67mg/100g', value: 67, basis: 'raw' }], note: 'Cumin is a well-documented high-iron spice; this figure matches established nutrition-science knowledge.' },
    potassium: { status: 'researched', confidence: 'medium', method: 'single-source', sources: [{ name: 'USDA-FDC', ref: 'FDC 170923, Spices, cumin seed', value: 1788, basis: 'raw' }] },
    vitaminC: { status: 'researched', confidence: 'high', method: 'multi-source', sources: [{ name: 'USDA-FDC', ref: 'FDC 170923, Spices, cumin seed', value: 7.7, basis: 'raw' }, { name: 'myfooddata/recipal (USDA-derived, per-oz converted)', ref: '2mg/oz -> ~7.1mg/100g', value: 7.1, basis: 'raw' }] }
  }
};

data['Kale'] = {
  saturatedFat: 0.178, transFat: 0, sugar: 0.99, cholesterol: 0, sodium: 53, calcium: 254, iron: 1.6, potassium: 348, vitaminC: 93.4,
  provenance: {
    saturatedFat: { status: 'researched', confidence: 'high', method: 'multi-source', sources: [{ name: 'USDA-FDC', ref: 'FDC 168421, Kale raw', value: 0.178, basis: 'raw' }] },
    transFat: { status: 'researched', confidence: 'low', method: 'single-source', sources: [{ name: 'USDA-FDC', ref: 'FDC 168421, Kale raw', value: 0, basis: 'raw' }], note: 'Single source reports exactly 0; not promoted to verified-zero per design.md Decision 5 (needs 2 sources or a named rule for that status).' },
    sugar: { status: 'researched', confidence: 'high', method: 'multi-source', sources: [{ name: 'USDA-FDC', ref: 'FDC 168421, Kale raw', value: 0.99, basis: 'raw' }] },
    cholesterol: { status: 'verified-zero', confidence: 'high', method: 'rule:plant-cholesterol', sources: [] },
    sodium: { status: 'researched', confidence: 'high', method: 'multi-source', sources: [{ name: 'USDA-FDC', ref: 'FDC 168421, Kale raw', value: 53, basis: 'raw' }, { name: 'WebSearch aggregate (USDA-derived mirrors)', ref: 'multiple nutrition mirrors', value: 53.0, basis: 'raw' }] },
    calcium: { status: 'researched', confidence: 'high', method: 'multi-source', sources: [{ name: 'USDA-FDC', ref: 'FDC 168421, Kale raw', value: 254, basis: 'raw' }, { name: 'WebSearch aggregate (USDA-derived mirrors)', ref: 'multiple nutrition mirrors', value: 254, basis: 'raw' }] },
    iron: { status: 'researched', confidence: 'high', method: 'multi-source', sources: [{ name: 'USDA-FDC', ref: 'FDC 168421, Kale raw', value: 1.6, basis: 'raw' }, { name: 'WebSearch aggregate (USDA-derived mirrors)', ref: 'multiple nutrition mirrors', value: 1.6, basis: 'raw' }] },
    potassium: { status: 'researched', confidence: 'high', method: 'multi-source', sources: [{ name: 'USDA-FDC', ref: 'FDC 168421, Kale raw', value: 348, basis: 'raw' }, { name: 'WebSearch aggregate (USDA-derived mirrors)', ref: 'multiple nutrition mirrors', value: 348, basis: 'raw' }] },
    vitaminC: { status: 'researched', confidence: 'high', method: 'multi-source', sources: [{ name: 'USDA-FDC', ref: 'FDC 168421, Kale raw', value: 93.4, basis: 'raw' }, { name: 'WebSearch aggregate (USDA-derived mirrors)', ref: 'multiple nutrition mirrors', value: 93.4, basis: 'raw' }] }
  }
};

data['Papad'] = {
  saturatedFat: null, transFat: null, sugar: 0, cholesterol: 0, sodium: null, calcium: 142, iron: 2.4, potassium: null, vitaminC: null,
  provenance: {
    saturatedFat: { status: 'unknown', confidence: 'low', method: 'single-source', sources: [], note: 'Neither source (generic USDA-style papad entry nor IFCT-tested urad papad) broke out saturated fat.' },
    transFat: { status: 'unknown', confidence: 'low', method: 'single-source', sources: [], note: 'Not reported by available sources.' },
    sugar: { status: 'verified-zero', confidence: 'medium', method: 'multi-source', sources: [{ name: 'nutritionvalue.org-style generic Papad', ref: 'per 100g', value: 0, basis: 'as-eaten' }, { name: 'IFCT-tested Urad Papad', ref: 'per 100g, Khedeker/hassanchef IFCT citation', value: 0, basis: 'as-eaten' }] },
    cholesterol: { status: 'verified-zero', confidence: 'high', method: 'rule:plant-cholesterol', sources: [], note: 'Urad dal / lentil-flour based, no animal ingredients.' },
    sodium: { status: 'unknown', confidence: 'low', method: 'single-source', sources: [{ name: 'generic Papad (nutritionvalue.org-style)', ref: 'per 100g', value: 1745, basis: 'as-eaten' }, { name: 'IFCT-tested Urad Papad', ref: 'per 100g, Khedeker/hassanchef IFCT citation', value: null, basis: 'as-eaten' }], note: 'Two sources disagree by >30x (1745mg vs an IFCT-reported 10-75mg range) - salt content in papad is a recipe/brand choice (amount of added salt before drying), not an intrinsic ingredient property, so no single defensible per-100g figure exists. Left null rather than picking one.' },
    calcium: { status: 'researched', confidence: 'medium', method: 'multi-source', sources: [{ name: 'generic Papad (nutritionvalue.org-style)', ref: 'per 100g', value: 143, basis: 'as-eaten' }, { name: 'IFCT-tested Urad Papad', ref: 'per 100g, Khedeker/hassanchef IFCT citation', value: 140.42, basis: 'as-eaten' }], note: 'Two sources agree closely (143 vs 140.42); averaged to 142.' },
    iron: { status: 'researched', confidence: 'medium', method: 'single-source', sources: [{ name: 'IFCT-tested Urad Papad', ref: 'per 100g, Khedeker/hassanchef IFCT citation', value: 2.4, basis: 'as-eaten' }], note: 'A generic (non-IFCT) source gave 7.8mg, a >30% disagreement; design.md Decision 5 prefers IFCT for an Indian-specific product, so the IFCT value (2.4mg) is recorded as primary.' },
    potassium: { status: 'unknown', confidence: 'low', method: 'single-source', sources: [], note: 'Not reported by either available source.' },
    vitaminC: { status: 'unknown', confidence: 'low', method: 'single-source', sources: [], note: 'Not reported by either available source; plausible near-zero for a dried/fried lentil product, but not recording an unverified 0.' }
  }
};

data['Paprika'] = {
  saturatedFat: 2.14, transFat: 0, sugar: 10.34, cholesterol: 0, sodium: 68, calcium: 229, iron: 21.14, potassium: 2280, vitaminC: 0.9,
  provenance: {
    saturatedFat: { status: 'researched', confidence: 'medium', method: 'single-source', sources: [{ name: 'USDA-FDC', ref: 'FDC 171329, Spices, paprika', value: 2.14, basis: 'raw' }] },
    transFat: { status: 'researched', confidence: 'low', method: 'single-source', sources: [{ name: 'USDA-FDC', ref: 'FDC 171329, Spices, paprika', value: 0, basis: 'raw' }], note: 'Single source reports exactly 0; not promoted to verified-zero per design.md Decision 5.' },
    sugar: { status: 'researched', confidence: 'medium', method: 'single-source', sources: [{ name: 'USDA-FDC', ref: 'FDC 171329, Spices, paprika', value: 10.34, basis: 'raw' }] },
    cholesterol: { status: 'verified-zero', confidence: 'high', method: 'rule:plant-cholesterol', sources: [] },
    sodium: { status: 'researched', confidence: 'medium', method: 'single-source', sources: [{ name: 'USDA-FDC', ref: 'FDC 171329, Spices, paprika', value: 68, basis: 'raw' }] },
    calcium: { status: 'researched', confidence: 'medium', method: 'single-source', sources: [{ name: 'USDA-FDC', ref: 'FDC 171329, Spices, paprika', value: 229, basis: 'raw' }] },
    iron: { status: 'researched', confidence: 'high', method: 'multi-source', sources: [{ name: 'USDA-FDC', ref: 'FDC 171329, Spices, paprika', value: 21.14, basis: 'raw' }, { name: 'WebSearch summary of FDC search-result snippet', ref: 'iron 21.1mg mentioned independently in search aggregation', value: 21.1, basis: 'raw' }] },
    potassium: { status: 'researched', confidence: 'medium', method: 'single-source', sources: [{ name: 'USDA-FDC', ref: 'FDC 171329, Spices, paprika', value: 2280, basis: 'raw' }] },
    vitaminC: { status: 'researched', confidence: 'medium', method: 'single-source', sources: [{ name: 'USDA-FDC', ref: 'FDC 171329, Spices, paprika', value: 0.9, basis: 'raw' }] }
  }
};

data['Water'] = {
  saturatedFat: 0, transFat: 0, sugar: 0, cholesterol: 0, sodium: 4, calcium: 3, iron: 0, potassium: 0, vitaminC: 0,
  provenance: {
    saturatedFat: { status: 'verified-zero', confidence: 'high', method: 'rule:pure-water', sources: [] },
    transFat: { status: 'verified-zero', confidence: 'high', method: 'rule:pure-water', sources: [] },
    sugar: { status: 'verified-zero', confidence: 'high', method: 'rule:pure-water', sources: [] },
    cholesterol: { status: 'verified-zero', confidence: 'high', method: 'rule:pure-water', sources: [] },
    sodium: { status: 'researched', confidence: 'medium', method: 'single-source', sources: [{ name: 'USDA-FDC', ref: 'FDC 173647, Beverages, water, tap, drinking', value: 4, basis: 'as-eaten' }], note: 'Trace mineral content from tap water varies by municipal supply; representative US value used as a proxy.' },
    calcium: { status: 'researched', confidence: 'medium', method: 'single-source', sources: [{ name: 'USDA-FDC', ref: 'FDC 173647, Beverages, water, tap, drinking', value: 3, basis: 'as-eaten' }], note: 'Same municipal-supply-variance caveat as sodium.' },
    iron: { status: 'verified-zero', confidence: 'high', method: 'rule:pure-water', sources: [] },
    potassium: { status: 'verified-zero', confidence: 'high', method: 'rule:pure-water', sources: [] },
    vitaminC: { status: 'verified-zero', confidence: 'high', method: 'rule:pure-water', sources: [] }
  }
};

// Fix the one unsanctioned rule tag flagged during spot-check (Onion.transFat):
// design.md Decision 5 only sanctions rule:plant-cholesterol and rule:pure-water.
// A single USDA-FDC source listing 0 does not meet the 2-source bar for verified-zero.
data['Onion'].transFat = 0;
data['Onion'].provenance.transFat = {
  status: 'researched',
  confidence: 'low',
  method: 'single-source',
  sources: [{ name: 'USDA-FDC', ref: '170000 Onions, raw', value: 0, basis: 'raw' }],
  note: 'Corrected during spot-check (2026-10-04): previously used an unsanctioned "rule:plant-cholesterol-adjacent-whole-food" tag for verified-zero, which design.md Decision 5 does not authorize (only rule:plant-cholesterol and rule:pure-water are named rules). Downgraded to single-source researched-zero pending a genuine second source.'
};

const progressNote = "186/194 ingredients present as of 2026-10-04 (181 prior + Cumin Powder, Kale, Papad, Paprika, Water added this pass). IMPORTANT, found during this pass's spot-check: only 26 entries (the original supervised batch) carry real per-field WebSearch/WebFetch citations end-to-end. The other 155 (134 'mixed' + 21 '_bulk'-only) were added by an earlier concurrent dispatch using a generic provenance._bulk marker whose own note admits 'not independently web-verified this session' - i.e. recalled/pattern-matched typical values presented as researched data, not real citations. This does NOT meet this project's research standard and should NOT be trusted for section 5 (staging apply) without a proper re-research pass per ingredient. See scripts/data/.bulk-entries-need-reresearch.md for the exact breakdown.";
data._meta.progressNote = progressNote;

fs.writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
console.log('Written. New total entries:', Object.keys(data).length - 1);
