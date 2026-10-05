const fs = require("fs");
const path = "scripts/data/fooditem-micronutrients.json";
const data = JSON.parse(fs.readFileSync(path, "utf8"));
const s1 = (v) => ({ name: "WebSearch aggregate (USDA-FDC)", ref: "FDC 169714, Rice flour white unenriched", value: v, basis: "raw" });
const s2 = (v) => ({ name: "triagemethod.com (USDA-FDC mirror)", ref: "FDC 169714, Rice flour white unenriched", value: v, basis: "raw" });
data["Rice Flour"] = {
  saturatedFat: 0.37, transFat: 0, sugar: 0.12, cholesterol: 0, sodium: 2.5, calcium: 8, iron: 0.28, potassium: 76, vitaminC: 0,
  provenance: {
    saturatedFat: { status: "researched", confidence: "high", method: "multi-source", sources: [s1(0.386), s2(0.36)] },
    transFat: { status: "researched", confidence: "medium", method: "single-source", sources: [s2(0)] },
    sugar: { status: "researched", confidence: "high", method: "multi-source", sources: [s1(0.12), s2(0.12)] },
    cholesterol: { status: "verified-zero", confidence: "high", method: "rule:plant-cholesterol", sources: [] },
    sodium: { status: "researched", confidence: "low", method: "multi-source", sources: [s1(0), s2(5.0)], note: "Sources disagree (0 vs 5mg); both plausible for a refined grain flour, kept as a flagged midpoint rather than discarding to null." },
    calcium: { status: "researched", confidence: "low", method: "multi-source", sources: [s1(10), s2(6.0)], note: "67% relative spread; kept as a flagged midpoint." },
    iron: { status: "researched", confidence: "low", method: "multi-source", sources: [s1(0.35), s2(0.22)], note: "41% relative spread; kept as a flagged midpoint." },
    potassium: { status: "researched", confidence: "high", method: "multi-source", sources: [s1(76), s2(75)] },
    vitaminC: { status: "verified-zero", confidence: "high", method: "multi-source", sources: [s1(0), s2(0)] }
  },
  note: "FDC 169714, Rice flour, white, unenriched."
};
fs.writeFileSync(path, JSON.stringify(data, null, 2));
console.log("Rice Flour written. 13/20 done.");
