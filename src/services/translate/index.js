// Machine-translation service — translates dynamic content with Gemini through
// OpenRouter, using the same provider/model configuration as AI Crop Doctor.
// Used by the `translate` GraphQL query, which caches results in `mt_cache` so
// each phrase is sent to Gemini only once (translate-once, then serve-from-DB).

import { env } from '../../config/env.js';

const KEY = env.ai?.openRouterApiKey || process.env.OPENROUTER_API_KEY || '';
const MODEL = env.ai?.openRouterModel || process.env.OPENROUTER_MODEL || 'google/gemini-3.1-flash-lite';
const URL = 'https://openrouter.ai/api/v1/chat/completions';

export const translateConfigured = Boolean(KEY);

const LANG_NAMES = {
  hi: 'Hindi', mr: 'Marathi', pa: 'Punjabi', gu: 'Gujarati', bn: 'Bengali',
  ta: 'Tamil', te: 'Telugu', kn: 'Kannada', ml: 'Malayalam', or: 'Odia',
};

function extractJsonArray(text) {
  if (!text) return null;
  // Strip ```json fences and grab the outermost [ ... ].
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1) return null;
  try {
    const arr = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(arr) ? arr.map((s) => String(s)) : null;
  } catch {
    return null;
  }
}

/**
 * Translate an array of strings into the target language via OpenRouter Gemini.
 * Returns an array aligned with the input; on any failure the originals are
 * returned so the UI degrades gracefully (English).
 */
export async function translateBatch(texts, lang) {
  const langName = LANG_NAMES[lang];
  if (!translateConfigured || !langName || !texts.length) return texts;

  const prompt =
    `Translate each string in the following JSON array from English to ${langName} (use the native script).\n` +
    `Rules:\n` +
    `- Return ONLY a JSON array of strings, same length and order as the input.\n` +
    `- Keep numbers, dates, units, currency symbols, product/brand names and codes unchanged.\n` +
    `- Translate naturally for an agriculture / farming app audience.\n` +
    `Input:\n${JSON.stringify(texts)}`;

  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${KEY}`,
        ...(env.ai?.openRouterSiteUrl ? { 'HTTP-Referer': env.ai.openRouterSiteUrl } : {}),
        'X-OpenRouter-Title': env.ai?.openRouterAppName || 'Cropland CRM',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
      }),
    });
    if (!res.ok) return texts;
    const data = await res.json();
    const out = extractJsonArray(data?.choices?.[0]?.message?.content);
    if (!out || out.length !== texts.length) return texts;
    return out;
  } catch {
    return texts;
  }
}
