/**
 * AI-generated recipe photos - the same pattern utils/ingredientLibrary.js
 * already uses for ingredient images (fetch/generate -> mirror into
 * Cloudinary -> persist the URL), but for a recipe's own main dish photo,
 * generated rather than searched for.
 *
 * Jev (utils/jevClient.js) makes two fast, cheap art-direction judgments per
 * recipe from its own catalog data (name/cuisine/category/servingTime/
 * ingredients) - which of a fixed set of photography styles fits the dish,
 * and which single ingredient should visually anchor the shot. A fixed
 * "house style" suffix (lighting/background/framing) is then appended in
 * code, not by the model, so every generated photo stays on-brand
 * regardless of what Jev picks. OpenAI's image model renders the result.
 *
 * This closes the "196 recipes need photos and manual upload doesn't scale"
 * gap - see the "docwellness-specs" OpenSpec change this shipped under for
 * the full rationale. A dietician can always overwrite the result via the
 * existing POST /uploads/recipe-image + PATCH /recipes/:id flow; this only
 * ever sets `imageSource: 'ai-generated'` so that override is distinguishable
 * from a dietician's own upload.
 */

const OpenAI = require('openai');
const config = require('../config/environment');
const cloudinary = require('../config/cloudinary');
const { cloudinaryUserFolder } = require('./cloudinaryFolder');
const { askJev } = require('./jevClient');
const Recipe = require('../models/Recipe');

const openai = new OpenAI({ apiKey: config.openai.apiKey });

// A small, fixed taxonomy - keeps the whole catalog's photography visually
// consistent without a human tagging every recipe by hand. Extend this (and
// STYLE_FRAMING below) together if a new dish shape doesn't fit any bucket.
const STYLE_CRITERIA = {
  plated_main: 'A cooked, saucy or mixed main dish served on a plate or shallow bowl - curries, rice dishes, stir-fries, pan-cooked dishes.',
  styled_bowl: 'Fresh, colorful ingredients arranged in a wide bowl, often with raw/crunchy elements - grain bowls, legume/chickpea bowls, salads.',
  snack_board: 'A small snack or bite-sized food, shown close-up on a small plate, napkin, or rustic wooden board - energy balls, chaat, roasted bites.',
  drink_glass: 'A beverage shown in a glass, mug, or cup - teas, milk drinks, smoothies, infused water.',
};

const STYLE_FRAMING = {
  plated_main: 'served on a simple ceramic plate, shot from a 45-degree angle',
  styled_bowl: 'arranged in a wide ceramic bowl, overhead flat-lay angle',
  snack_board: 'arranged on a small rustic wooden board, close-up shot',
  drink_glass: 'served in a clear glass or ceramic mug, shot from a slight side angle',
};

const HOUSE_STYLE_SUFFIX =
  'natural soft daylight, minimal rustic props, clean neutral warm-white background, ' +
  'shallow depth of field, appetizing and wholesome, no text, no logos, no people, high resolution';

/**
 * Asks Jev which photography style and hero ingredient fit this recipe.
 * Exported separately from the full generate-and-store flow so the
 * decision itself (and its confidence/probabilities) can be inspected or
 * tested without spending on an actual image generation call.
 */
async function decideArtDirection(recipe) {
  const ingredients = (recipe.ingredients || []).map(
    (i) => `${i.name} (${i.quantity}${i.unit}, role: ${i.role})`
  );

  const heroOptions = {};
  for (const ing of recipe.ingredients || []) {
    const key = (ing.name || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (key) heroOptions[key] = `${ing.name} (${ing.quantity}${ing.unit})`;
  }
  // A recipe with no ingredients authored yet has nothing for Jev to pick a
  // hero from - fall back to the dish name itself rather than failing.
  if (Object.keys(heroOptions).length === 0) {
    heroOptions.the_dish_itself = recipe.name;
  }

  const state = {
    recipeName: recipe.name,
    cuisine: recipe.cuisine || null,
    category: recipe.category,
    servingTime: recipe.servingTime,
    ingredients,
  };

  const { answers } = await askJev({
    state,
    questions: {
      style_bucket: {
        type: 'choice',
        instructions: 'Which food-photography style best fits how this dish should be shown, based on its name, cuisine, category and serving time?',
        criteria: STYLE_CRITERIA,
      },
      hero_ingredient: {
        type: 'choice',
        instructions: "Which single ingredient should be the visual hero/focal point of this dish's photo - the one a viewer should recognize first?",
        criteria: heroOptions,
      },
    },
  });

  const style = answers.style_bucket?.choice in STYLE_FRAMING ? answers.style_bucket.choice : 'plated_main';
  const heroKey = answers.hero_ingredient?.choice;
  const heroLabel = heroKey && heroOptions[heroKey]
    ? heroOptions[heroKey].replace(/\s*\([^)]*\)$/, '')
    : recipe.name;

  return { style, heroLabel, jevAnswers: answers };
}

/** Pure function: art direction + recipe data -> the final image prompt string. */
function buildPrompt(recipe, { style, heroLabel }) {
  const framing = STYLE_FRAMING[style] || STYLE_FRAMING.plated_main;
  const cuisineClause = recipe.cuisine ? `, a ${recipe.cuisine} dish` : '';
  return `Professional food photography of ${recipe.name}${cuisineClause}: ${heroLabel} as the visual centerpiece, ${framing}, ${HOUSE_STYLE_SUFFIX}`;
}

/**
 * Generates a new photo for `recipeId` end-to-end (Jev art direction ->
 * prompt -> OpenAI image generation -> Cloudinary) and persists it onto the
 * Recipe document. Scoped to `dieticianId` - only that recipe's own owner
 * can trigger this, same authorization shape as every other recipe mutation
 * in this controller.
 *
 * Returns `{ ok: true, url, prompt, artDirection }` or
 * `{ ok: false, status, message }` - never throws for an expected failure
 * (recipe not found, generation/upload failure), so callers can turn it
 * directly into an HTTP response.
 */
async function generateAndStoreRecipeImage({ recipeId, dieticianId }) {
  const recipe = await Recipe.findOne({ _id: recipeId, dieticianId }).lean();
  if (!recipe) {
    return { ok: false, status: 404, message: 'Recipe not found' };
  }

  const artDirection = await decideArtDirection(recipe);
  const prompt = buildPrompt(recipe, artDirection);

  let generation;
  try {
    generation = await openai.images.generate({
      model: config.openai.recipeImageModel,
      prompt,
      size: '1536x1024',
      n: 1,
    });
  } catch (error) {
    console.error(`Recipe image generation failed for ${recipeId}:`, error.message);
    return { ok: false, status: 502, message: "Couldn't generate an image right now. Please try again." };
  }

  const item = generation?.data?.[0];
  // gpt-image-1 always returns b64_json; a url-returning model (e.g.
  // dall-e-3 without an explicit response_format) is handled too, so this
  // isn't locked to one image model.
  const uploadSource = item?.b64_json ? `data:image/png;base64,${item.b64_json}` : item?.url;
  if (!uploadSource) {
    return { ok: false, status: 502, message: 'Image generation returned no image' };
  }

  let uploadResult;
  try {
    uploadResult = await cloudinary.uploader.upload(uploadSource, {
      folder: cloudinaryUserFolder(dieticianId, 'recipes/main'),
    });
  } catch (error) {
    console.error(`Cloudinary upload failed for generated recipe image (${recipeId}):`, error.message);
    return { ok: false, status: 502, message: 'Failed to store the generated image' };
  }
  const imageUrl = uploadResult?.secure_url || uploadResult?.url;
  if (!imageUrl) {
    return { ok: false, status: 502, message: 'Failed to store the generated image' };
  }

  await Recipe.updateOne(
    { _id: recipeId, dieticianId },
    { $set: { image: imageUrl, imageSource: 'ai-generated' } }
  );

  return {
    ok: true,
    url: imageUrl,
    prompt,
    artDirection: { style: artDirection.style, heroLabel: artDirection.heroLabel },
  };
}

module.exports = { generateAndStoreRecipeImage, decideArtDirection, buildPrompt };
