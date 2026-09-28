/**
 * Thin caller for TypeSafe's Jev (System One) native API - fast, cheap
 * typed judgments (choice/score/noul) over text state, used to keep
 * AI-generated content decisions (currently: recipe photo art direction,
 * see utils/recipeImageGenerator.js) consistent across the catalog without
 * a human authoring per-item rules. Jev never writes or generates content
 * itself - callers own the workflow and turn its answers into prompts,
 * filters, or routing decisions.
 */

const config = require('../config/environment');

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-latest';

/**
 * @param {object} params
 * @param {*} params.state - the content to evaluate (string, object, or array)
 * @param {object} params.questions - map of { [key]: { type: 'choice'|'score'|'noul', instructions, criteria } }
 * @returns {Promise<{answers: object, usage: {input_tokens, output_tokens}}>}
 */
async function askJev({ state, questions }) {
  const apiKey = config.typesafe.apiKey;
  if (!apiKey) {
    throw new Error('TYPESAFE_API_KEY is not set - cannot call Jev.');
  }

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: MODEL, state, questions }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Jev request failed: HTTP ${response.status} ${response.statusText} - ${text}`);
  }
  return JSON.parse(text);
}

module.exports = { askJev };
