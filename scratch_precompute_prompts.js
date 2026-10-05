require('dotenv').config();
const fs = require('fs');
const { decideArtDirection, buildPrompt } = require('./utils/recipeImageGenerator');

const SCRATCH = 'C:/Users/bhush/AppData/Local/Temp/claude/C--Users-bhush-docwellness-workspace-docwellness-specs/44b71281-21c2-4fab-897b-c8ab773059fc/scratchpad';
const recipes = JSON.parse(fs.readFileSync(`${SCRATCH}/recipes_full_missing_image.json`, 'utf8'));

(async () => {
  const manifest = [];
  for (let i = 0; i < recipes.length; i++) {
    const recipe = recipes[i];
    try {
      const artDirection = await decideArtDirection(recipe);
      const prompt = buildPrompt(recipe, artDirection);
      manifest.push({
        recipeId: recipe._id,
        dieticianId: recipe.dieticianId,
        name: recipe.name,
        style: artDirection.style,
        heroLabel: artDirection.heroLabel,
        prompt,
        status: 'pending',
      });
      console.log(`[${i + 1}/${recipes.length}] ${recipe.name} -> ${artDirection.style} / ${artDirection.heroLabel}`);
    } catch (err) {
      console.error(`[${i + 1}/${recipes.length}] FAILED ${recipe.name}: ${err.message}`);
      manifest.push({
        recipeId: recipe._id,
        dieticianId: recipe.dieticianId,
        name: recipe.name,
        status: 'jev_failed',
        error: err.message,
      });
    }
  }
  fs.writeFileSync(`${SCRATCH}/image_gen_manifest.json`, JSON.stringify(manifest, null, 2));
  console.log('Done. Manifest written.');
})();
