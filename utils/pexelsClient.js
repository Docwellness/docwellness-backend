/**
 * Fetches a real photo of an ingredient from Pexels (free image search API,
 * no attribution required for our use case). Used by the "refresh image"
 * feature so ingredient images always come from the internet rather than a
 * device photo upload.
 */

const PEXELS_SEARCH_URL = 'https://api.pexels.com/v1/search';

/**
 * Searches Pexels for a photo matching the given ingredient name and
 * returns a direct image URL, or null if nothing usable was found (missing
 * API key, no results, or a request failure - all treated as best-effort).
 */
async function fetchIngredientImageUrl(ingredientName) {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey) {
    console.error('PEXELS_API_KEY is not set - cannot fetch ingredient images from the internet.');
    return null;
  }
  if (!ingredientName || !ingredientName.trim()) return null;

  const query = `${ingredientName.trim()} food ingredient`;
  const url = `${PEXELS_SEARCH_URL}?query=${encodeURIComponent(query)}&per_page=10`;

  try {
    const response = await fetch(url, {
      headers: { Authorization: apiKey },
    });
    if (!response.ok) {
      console.error(`Pexels search failed for "${ingredientName}": ${response.status} ${response.statusText}`);
      return null;
    }
    const data = await response.json();
    const photos = Array.isArray(data.photos) ? data.photos : [];
    if (photos.length === 0) return null;

    // Pick randomly among the results so repeated "refresh" calls for the
    // same ingredient return different images instead of always the top hit.
    const pick = photos[Math.floor(Math.random() * photos.length)];
    return pick?.src?.large || pick?.src?.medium || pick?.src?.original || null;
  } catch (error) {
    console.error(`Pexels search error for "${ingredientName}":`, error.message);
    return null;
  }
}

module.exports = { fetchIngredientImageUrl };
