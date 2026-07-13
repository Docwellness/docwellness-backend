const OpenAI = require('openai');
const config = require('../config/environment');

const openai = new OpenAI({ apiKey: config.openai.apiKey });

/**
 * Runs free text through OpenAI's Moderation API before it is interpolated
 * into any generation prompt - the primary defense against unsafe content
 * and prompt injection (OWASP LLM01) via free-text fields like a recipe's
 * aiNote or a patient's consultation "foods to avoid"/notes text.
 *
 * Fails open on a Moderation API error (logs and allows the text through)
 * rather than blocking the dietician's core workflow on a third-party outage
 * - this is a defense-in-depth screen, not the only safety layer (dietary
 * constraint checks and mandatory human review still apply regardless).
 */
async function checkTextSafety(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) {
    return { safe: true, categories: [] };
  }

  try {
    const result = await openai.moderations.create({
      model: 'omni-moderation-latest',
      input: trimmed,
    });
    const flaggedResult = result?.results?.[0];

    if (flaggedResult?.flagged) {
      const categories = Object.entries(flaggedResult.categories || {})
        .filter(([, isFlagged]) => isFlagged)
        .map(([category]) => category);
      return { safe: false, categories };
    }

    return { safe: true, categories: [] };
  } catch (error) {
    console.error('Moderation check failed, allowing content through:', error.message);
    return { safe: true, categories: [], checkFailed: true };
  }
}

module.exports = { checkTextSafety };
