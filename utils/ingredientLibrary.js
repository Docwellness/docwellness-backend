/**
 * Shared per-dietician ingredient image library. An image fetched once for
 * "Onion" is reused by every recipe that has an "Onion" ingredient instead
 * of each occurrence independently hitting Pexels - see models/Ingredient.js
 * for why this stays a separate collection rather than restructuring
 * Recipe.ingredients itself.
 */

const Ingredient = require('../models/Ingredient');
const cloudinary = require('../config/cloudinary');
const { cloudinaryUserFolder } = require('./cloudinaryFolder');
const { fetchIngredientImageUrl } = require('./pexelsClient');

const normalize = (name) => name.trim().toLowerCase();

/**
 * Mirrors a Pexels result into Cloudinary (remote-URL upload, no manual
 * download step) - same storage pattern as the existing device-upload flow.
 */
async function mirrorToCloudinary(sourceUrl, dieticianId) {
  const uploadResult = await cloudinary.uploader.upload(sourceUrl, {
    folder: cloudinaryUserFolder(dieticianId, 'recipes/ingredients'),
  });
  return uploadResult?.secure_url || uploadResult?.url || null;
}

/**
 * Returns an image URL for `name`, reusing the dietician's shared library
 * whenever possible.
 *
 * - forceRefresh:false (auto-fetch paths - createRecipe, backfill): reuses
 *   an existing shared image if one exists, skipping Pexels entirely.
 * - forceRefresh:true (the manual "refresh" button): always fetches a new
 *   image from Pexels and overwrites the shared library's image with it,
 *   since a refresh click means "I want something different."
 *
 * Returns { image: string|null, reused: boolean, category: string|undefined }.
 */
async function getOrCreateIngredientImage({ dieticianId, name, category, forceRefresh = false }) {
  if (!name || !name.trim()) return { image: null, reused: false };
  const normalizedName = normalize(name);

  if (!forceRefresh) {
    const existing = await Ingredient.findOne({ dieticianId, normalizedName }).lean();
    if (existing?.image) {
      return { image: existing.image, reused: true, category: existing.category };
    }
  }

  const sourceUrl = await fetchIngredientImageUrl(name);
  if (!sourceUrl) return { image: null, reused: false };

  let mirroredUrl;
  try {
    mirroredUrl = await mirrorToCloudinary(sourceUrl, dieticianId);
  } catch (error) {
    console.error(`Cloudinary mirror failed for "${name}":`, error.message);
    return { image: null, reused: false };
  }
  if (!mirroredUrl) return { image: null, reused: false };

  await Ingredient.findOneAndUpdate(
    { dieticianId, normalizedName },
    { $set: { name: name.trim(), image: mirroredUrl, ...(category ? { category } : {}) } },
    { upsert: true }
  );

  return { image: mirroredUrl, reused: false, category };
}

module.exports = { getOrCreateIngredientImage, normalize };
