// AI service — crop disease/pest diagnosis, photo captioning and advisory
// generation. Provider: Groq when GROQ_API_KEY is set, otherwise Google Gemini
// (GEMINI_API_KEY + GEMINI_MODEL). Gemini also provides the retrieval embeddings.
// Product recommendations are grounded in the company catalog (products table):
// the model picks catalog codes, it never invents brand names.

import { env } from '../../config/env.js';
import { query } from '../../db/index.js';
import { getDownloadUrl, isAwsConfigured } from '../../utils/aws.js';

const GROQ_KEY   = env.ai?.groqApiKey || process.env.GROQ_API_KEY || '';
const GROQ_MODEL = env.ai?.groqModel  || process.env.GROQ_MODEL   || 'meta-llama/llama-4-scout-17b-16e-instruct';
const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions';

const GEMINI_KEY   = env.ai?.geminiApiKey || process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
const EMBED_MODEL  = env.ai?.embeddingModel || 'gemini-embedding-001';
const EMBED_DIM    = env.ai?.embeddingDim   || 768;
const GEMINI       = 'https://generativelanguage.googleapis.com/v1beta/models';

const PROVIDER = GROQ_KEY ? 'groq' : GEMINI_KEY ? 'gemini' : null;
const MODEL    = PROVIDER === 'groq' ? GROQ_MODEL : GEMINI_MODEL;
export const aiConfigured = Boolean(PROVIDER);

const TIMEOUT_MS = 45_000;
const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH'];
const LANGS = { hi: 'Hindi', mr: 'Marathi', pa: 'Punjabi', gu: 'Gujarati', te: 'Telugu', ta: 'Tamil', kn: 'Kannada', bn: 'Bengali', ml: 'Malayalam', or: 'Odia' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assertConfigured() {
  if (!aiConfigured) throw new Error('AI Crop Doctor is not configured. Set GEMINI_API_KEY (or GROQ_API_KEY) on the server.');
}

function providerError(status, detail = '') {
  if (status === 429) return new Error('AI service is busy right now (rate limit reached). Please try again in a minute.');
  if (status === 401 || status === 403) return new Error('AI service rejected the server API key. Ask an admin to check GEMINI_API_KEY / GROQ_API_KEY.');
  if (status === 400 && /image|inline|mime/i.test(detail)) return new Error('AI could not read this photo. Please upload a clear JPG or PNG image.');
  if (status >= 500) return new Error('AI service is temporarily unavailable. Please try again in a moment.');
  return new Error('AI request failed. Please try again.');
}

/** POST JSON with a timeout; retries once on network error, 429 or 5xx. */
async function postJson(label, url, headers, body) {
  for (let attempt = 0; ; attempt += 1) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      if (err?.name === 'TimeoutError') throw new Error('AI service took too long to respond. Please try again.');
      if (attempt === 0) { await sleep(1500); continue; }
      throw new Error('Could not reach the AI service. Check the server internet connection and try again.');
    }
    if (res.ok) return res.json();
    const detail = await res.text().catch(() => '');
    console.error(`[ai:${label}] HTTP ${res.status} attempt=${attempt}: ${detail.slice(0, 400)}`);
    if (attempt === 0 && (res.status === 429 || res.status >= 500)) { await sleep(res.status === 429 ? 3000 : 1500); continue; }
    throw providerError(res.status, detail);
  }
}

/**
 * One generation call. `parts` is an array of { text } | { image: { base64, mime } }.
 * Returns the model's text.
 */
async function generate(parts, { json = false, temperature = 0.3, maxTokens = 1200 } = {}) {
  assertConfigured();
  if (PROVIDER === 'groq') {
    const content = parts.map((p) => (p.image
      ? { type: 'image_url', image_url: { url: `data:${p.image.mime};base64,${p.image.base64}` } }
      : { type: 'text', text: p.text }));
    const data = await postJson('groq', GROQ_URL, { Authorization: `Bearer ${GROQ_KEY}` }, {
      model: GROQ_MODEL,
      messages: [{ role: 'user', content }],
      ...(json ? { response_format: { type: 'json_object' } } : {}),
      temperature,
      max_tokens: maxTokens,
    });
    return data?.choices?.[0]?.message?.content ?? '';
  }
  const data = await postJson('gemini', `${GEMINI}/${GEMINI_MODEL}:generateContent`, { 'x-goog-api-key': GEMINI_KEY }, {
    contents: [{
      role: 'user',
      parts: parts.map((p) => (p.image ? { inline_data: { mime_type: p.image.mime, data: p.image.base64 } } : { text: p.text })),
    }],
    generationConfig: { temperature, maxOutputTokens: maxTokens, ...(json ? { responseMimeType: 'application/json' } : {}) },
  });
  const cand = data?.candidates?.[0];
  const text = (cand?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  if (!text) {
    const why = data?.promptFeedback?.blockReason || cand?.finishReason || 'empty response';
    console.error(`[ai:gemini] no text (${why})`);
    throw new Error('AI could not analyse this input. Please try a clearer crop photo or add a short symptom description.');
  }
  return text;
}

/** Tolerant JSON parse: strips ``` fences and grabs the outermost {...}. */
export function parseJsonLoose(text) {
  if (!text) return {};
  const t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch { /* try the braces */ }
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s >= 0 && e > s) { try { return JSON.parse(t.slice(s, e + 1)); } catch { /* fall through */ } }
  return {};
}

async function generateJson(parts, opts) {
  return parseJsonLoose(await generate(parts, { ...opts, json: true }));
}

const str = (v) => (v == null ? null : (Array.isArray(v) ? v.join('; ') : String(v)).replace(/\*\*/g, '').trim() || null);

// ── Images ────────────────────────────────────────────────────────────────────

async function fetchImage(url) {
  try { return await fetch(url, { signal: AbortSignal.timeout(15_000) }); } catch { return null; }
}

/** S3 object key for a raw key or an S3 https URL (private bucket fallback). */
function s3KeyOf(url) {
  if (!/^https?:\/\//i.test(url)) return url;
  try {
    const u = new URL(url);
    return /amazonaws\.com$/i.test(u.hostname) ? decodeURIComponent(u.pathname.slice(1)) : null;
  } catch { return null; }
}

/** Resolve a data: URL, https URL or S3 key to { base64, mime }. */
async function toInlineData(url) {
  if (!url) return null;
  const m = /^data:(image\/[\w+.-]+);base64,(.+)$/s.exec(url);
  if (m) return { base64: m[2], mime: m[1] };
  let res = /^https?:\/\//i.test(url) ? await fetchImage(url) : null;
  if (!res?.ok && isAwsConfigured) {
    const key = s3KeyOf(url);
    if (key) res = await fetchImage(await getDownloadUrl(key).catch(() => url));
  }
  if (!res?.ok) throw new Error('Could not load the crop photo. Please upload it again.');
  const mime = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
  // S3 may serve images as octet-stream; anything else (an HTML page link) is not a photo.
  if (!mime.startsWith('image/') && mime !== 'application/octet-stream') throw new Error('That link is not an image. Please upload a JPG or PNG crop photo.');
  return { base64: Buffer.from(await res.arrayBuffer()).toString('base64'), mime: mime.startsWith('image/') ? mime : 'image/jpeg' };
}

// ── Company catalog grounding ─────────────────────────────────────────────────

// Label crop groups ("Vegetables") → member crops. ponytail: common Indian crops only; extend when labels use other groups.
const CROP_GROUPS = {
  vegetable: 'tomato potato brinjal okra bhindi chilli capsicum onion garlic cabbage cauliflower cucumber gourd peas carrot radish',
  fruit: 'grape pomegranate mango banana citrus orange papaya guava apple',
  cereal: 'paddy wheat maize bajra jowar barley',
  pulse: 'gram chickpea tur arhar moong urad lentil',
  oilseed: 'soybean groundnut mustard sunflower sesame castor',
};
const normCrop = (c) => { const x = String(c ?? '').trim().toLowerCase(); return x === 'rice' ? 'paddy' : x; };
const tcFits = (tc, crop) => {
  const t = normCrop(tc);
  if (t === crop || /^(all|any)\b/.test(t)) return true;
  const g = Object.keys(CROP_GROUPS).find((k) => t.startsWith(k));
  return Boolean(g && CROP_GROUPS[g].split(' ').includes(crop));
};
/** Is `crop` on this product's label? No label crops = unrestricted. */
export const labelFits = (targetCrops, crop) => !targetCrops?.length || targetCrops.some((tc) => tcFits(tc, normCrop(crop)));

/** Active products labelled for this crop (one row per product name, exact crop match first) for prompts. */
export async function loadCatalog(crop) {
  const { rows } = await query(
    `SELECT DISTINCT ON (lower(name)) id, name, technical_name, category::text AS category, target_crops, target_diseases, recommended_dosage
     FROM products WHERE is_active ORDER BY lower(name), created_at`,
  );
  // Off-label products are never shown to the model, so it cannot recommend them.
  const exact = (p) => (p.target_crops ?? []).some((tc) => normCrop(tc) === normCrop(crop));
  return rows.filter((p) => labelFits(p.target_crops, crop))
    .sort((a, b) => Number(exact(b)) - Number(exact(a)))
    .slice(0, 60);
}

function catalogBlock(catalog) {
  if (!catalog?.length) return 'Company product catalog: (empty) — recommend by technical/active-ingredient name only and return "productCodes": [].';
  const lines = catalog.map((p, i) => [
    `P${i + 1}`, p.name, p.technical_name || '-', p.category || '-',
    `crops: ${(p.target_crops ?? []).join(', ') || '-'}`,
    `targets: ${(p.target_diseases ?? []).join(', ') || '-'}`,
    ...(p.recommended_dosage ? [`label dose: ${p.recommended_dosage}`] : []),
  ].join(' | '));
  return `Company product catalog (code | brand | technical name | category | label crops | label targets | dose):\n${lines.join('\n')}\n`
    + 'Recommend company products ONLY by these codes, only when the technical name genuinely controls the problem AND its label crops include this crop (or are "-"/All) — never suggest off-label use; otherwise name the active ingredient only. In text write "technical name (brand)" for a catalog product and never write the codes themselves. Never invent or mention other brand names; outside the catalog refer to active ingredients only.';
}

/** Swap any catalog codes the model still leaked into prose ("(P3)", "P3") for the brand name. */
export const decodeCodes = (text, catalog) => text && text.replace(/(\()?\bP(\d{1,2})\b(\))?/g, (m, open, n, close) => {
  const p = catalog?.[Number(n) - 1];
  return p ? `${open ?? ''}${p.name}${close ?? ''}` : m;
});

const codesToIds = (codes, catalog) => [...new Set((Array.isArray(codes) ? codes : [])
  .map((c) => catalog?.[Number(String(c).replace(/\D/g, '')) - 1]?.id)
  .filter(Boolean))].slice(0, 4);

// ── Embeddings (Gemini) ───────────────────────────────────────────────────────

export async function embedText(text) {
  if (!GEMINI_KEY || !text) return null;
  try {
    const data = await postJson('embed', `${GEMINI}/${EMBED_MODEL}:embedContent`, { 'x-goog-api-key': GEMINI_KEY }, {
      model: `models/${EMBED_MODEL}`, content: { parts: [{ text }] }, outputDimensionality: EMBED_DIM,
    });
    return data?.embedding?.values ?? null;
  } catch { return null; }
}

/** One-sentence visual caption of a crop photo (for training-sample retrieval). */
export async function captionImage(imageUrl, crop = 'crop') {
  if (!aiConfigured || !imageUrl) return null;
  try {
    const img = await toInlineData(imageUrl);
    const text = await generate([
      { text: `Describe this ${crop} plant photo for disease retrieval in ONE sentence: leaf colour, lesion/spot pattern, pest signs, affected part. No preamble.` },
      { image: img },
    ], { temperature: 0.2, maxTokens: 200 });
    return text.trim() || null;
  } catch { return null; }
}

/** Caption the photo, then embed "label. caption". Returns { caption, vector } or null. */
export async function embedSample(imageUrl, label, crop) {
  if (!aiConfigured || !GEMINI_KEY) return null;
  const caption = await captionImage(imageUrl, crop);
  const vector = await embedText([label, caption].filter(Boolean).join('. '));
  return vector ? { caption, vector } : null;
}

/** Cosine similarity between two equal-length vectors. */
export function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// ── Diagnosis ─────────────────────────────────────────────────────────────────

const EXPERT = 'You are a senior plant pathologist and entomologist advising Indian farmers (ICAR / state agricultural university practice, CIB&RC-registered chemistry, doses per acre; typical knapsack spray volume 150-200 L water/acre).';

/**
 * Diagnose a crop problem from a photo and/or a symptom description.
 * `references` (Train AI Doctor) are sent as labelled few-shot photos.
 * `catalog` defaults to the company product catalog for this crop.
 * Returns { disease, pathogen, confidence, severity, symptoms, recommendation, productIds, source }.
 */
export async function diagnoseCrop({ crop, imageUrl, references = [], lang, symptoms, catalog }) {
  assertConfigured();
  const cat = catalog ?? await loadCatalog(crop);
  const language = LANGS[lang];
  const parts = [{ text: `${EXPERT}\nCrop reported by the farmer: ${crop}.${symptoms ? `\nFarmer's description: ${symptoms}` : ''}` }];

  let usedRefs = 0;
  const refs = imageUrl ? references.slice(0, 4) : [];
  if (refs.length) {
    parts.push({ text: `Labelled REFERENCE photos of known ${crop} conditions from our field library (use them to ground your judgement):` });
    const imgs = await Promise.all(refs.map((r) => toInlineData(r.imageUrl).catch(() => null)));
    refs.forEach((r, i) => {
      if (!imgs[i]) return;
      parts.push({ text: `Reference — ${r.disease}${r.pathogen ? ` (${r.pathogen})` : ''}${r.caption ? `: ${r.caption}` : ''}` }, { image: imgs[i] });
      usedRefs += 1;
    });
  } else if (!imageUrl && references.length) {
    parts.push({ text: `Conditions already recorded for this crop in our system: ${references.slice(0, 6).map((r) => r.disease).filter(Boolean).join(', ')}.` });
  }

  if (imageUrl) {
    parts.push({ text: `Now diagnose THIS photo of the farmer's ${crop} crop.` }, { image: await toInlineData(imageUrl) });
  } else {
    parts.push({ text: 'No photo was provided: diagnose the most likely problem from the crop, the description and the current Indian season, and keep confidence at or below 60.' });
  }

  parts.push({ text: `${catalogBlock(cat)}

Identify the disease, insect/mite pest, nutrient deficiency or abiotic disorder. If the photo is not a plant or is too unclear, set "disease" to "Unclear image" with confidence below 20. If the plant looks healthy, set "disease" to "Healthy" and severity "LOW".
Respond with JSON only:
{
  "disease": common English name,
  "pathogen": scientific name of the pathogen/pest, or null,
  "confidence": integer 0-100 (be honest; lower it when unsure),
  "severity": "LOW" | "MEDIUM" | "HIGH",
  "symptoms": 1-2 sentences on the visible/likely symptoms,
  "cause": 1 sentence on the cause and favourable conditions,
  "cultural": 1-2 practical cultural/mechanical measures,
  "biological": 1 biological or organic option with dose, or null,
  "chemical": 1-2 chemical options by technical name with dose per acre (and per litre of water) and spray interval,
  "safety": pre-harvest interval (days) and key safety/PPE precautions,
  "productCodes": up to 3 catalog codes (e.g. ["P2"]) that match the chemical/biological advice, or []
}${language ? `\nWrite every text value in ${language}; keep JSON keys, codes and scientific names in English.` : ''}` });

  const j = await generateJson(parts, { temperature: 0.2, maxTokens: 1200 });
  const disease = str(j.disease);
  if (!disease) throw new Error('AI returned an incomplete answer. Please try again.');
  let confidence = Number(j.confidence) || 0;
  if (confidence > 0 && confidence <= 1) confidence *= 100;
  const severity = String(j.severity ?? '').toUpperCase();
  const recommendation = [
    ['Cause', j.cause], ['Cultural', j.cultural], ['Biological', j.biological], ['Chemical', j.chemical], ['Safety & PHI', j.safety],
  ].map(([k, v]) => (str(v) ? `${k}: ${decodeCodes(str(v), cat)}` : null)).filter(Boolean).join('\n') || str(j.recommendation);

  return {
    disease,
    pathogen: str(j.pathogen),
    confidence: Math.max(0, Math.min(100, Math.round(confidence))),
    severity: SEVERITIES.includes(severity) ? severity : 'MEDIUM',
    symptoms: str(j.symptoms),
    recommendation,
    productIds: codesToIds(j.productCodes, cat),
    source: `${PROVIDER}${imageUrl ? '' : '-text'}${usedRefs ? `+${usedRefs}ref` : ''}`,
  };
}

/** Preventive/curative advisory. Returns { title, body, productIds, source }. */
export async function generateAdvisory({ crop, disease, type, catalog }) {
  assertConfigured();
  const cat = catalog ?? await loadCatalog(crop);
  const month = new Date().toLocaleString('en-IN', { month: 'long', timeZone: 'Asia/Kolkata' });
  const kind = type === 'PREVENTIVE' ? 'PREVENTIVE' : 'CURATIVE';
  const j = await generateJson([{ text: `${EXPERT}
Write a ${kind.toLowerCase()} crop advisory about ${disease || 'overall crop health and the main seasonal pest/disease risks'} in ${crop} for smallholder Indian farmers. Current month: ${month} (consider the Kharif/Rabi/Zaid season).
${catalogBlock(cat)}

Respond with JSON only:
{
  "title": short title, max 80 characters,
  "body": plain text, 6-9 numbered steps ("1. ..."), one per line: ${kind === 'PREVENTIVE'
    ? 'risk window and scouting / economic threshold, resistant varieties & seed treatment, cultural practices, biological options, prophylactic chemical spray by technical name with dose per litre and per acre (150-200 L water/acre), spray timing, PHI & safety'
    : 'how to confirm the problem, immediate cultural steps, biological option, chemical control by technical name with dose per litre and per acre (150-200 L water/acre), spray interval & rotation, PHI & safety, what to avoid'}. No markdown (** or #),
  "productCodes": up to 3 catalog codes that fit the advice, or []
}` }], { temperature: 0.4, maxTokens: 1400 });
  const body = decodeCodes(str(Array.isArray(j.body) ? j.body.join('\n') : j.body), cat);
  if (!body) throw new Error('AI returned an incomplete advisory. Please try again.');
  return {
    title: (str(j.title) ?? `${kind === 'PREVENTIVE' ? 'Preventive' : 'Curative'} advisory — ${crop}`).slice(0, 120),
    body,
    productIds: codesToIds(j.productCodes, cat),
    source: PROVIDER,
  };
}

export function aiChannelStatus() {
  return { provider: PROVIDER ?? 'none', model: PROVIDER ? MODEL : 'not configured', embeddingModel: EMBED_MODEL, configured: aiConfigured };
}
