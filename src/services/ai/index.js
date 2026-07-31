// AI service — Groq (llama-4-scout-17b-16e-instruct) for crop disease detection,
// image captioning and advisory generation. Google Gemini is retained for
// embeddings only (gemini-embedding-001) since Groq has no embedding model.
// Falls back to a deterministic mock when GROQ_API_KEY is unset.

import { env } from '../../config/env.js';
import { getDownloadUrl } from '../../utils/aws.js';

// ── Groq (generation) ─────────────────────────────────────────────────────────
const GROQ_KEY   = env.ai?.groqApiKey   || process.env.GROQ_API_KEY   || '';
const GROQ_MODEL = env.ai?.groqModel    || process.env.GROQ_MODEL      || 'meta-llama/llama-4-scout-17b-16e-instruct';
const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions';

// ── Gemini (embeddings only) ──────────────────────────────────────────────────
const GEMINI_KEY  = env.ai?.geminiApiKey  || process.env.GEMINI_API_KEY  || '';
const EMBED_MODEL = env.ai?.embeddingModel || 'gemini-embedding-001';
const EMBED_DIM   = env.ai?.embeddingDim   || 768;
const GEMINI      = 'https://generativelanguage.googleapis.com/v1beta/models';

export const aiConfigured = Boolean(GROQ_KEY);

// Valid severity levels returned by the model.
const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH'];

// Thrown when a diagnosis is attempted without a configured Groq key. The Crop
// Doctor is Groq-only — there is no demo/mock fallback.
function assertConfigured() {
  if (!aiConfigured) {
    throw new Error('AI Crop Doctor is not configured. Please set GROQ_API_KEY on the server.');
  }
}

// ── Groq helpers ──────────────────────────────────────────────────────────────

function groqError(status) {
  if (status === 429) return new Error('AI service is busy right now (rate limit reached). Please try again in a moment.');
  if (status === 401 || status === 403) return new Error('AI service is not available right now. Please try again later.');
  if (status >= 500) return new Error('AI service is temporarily unavailable. Please try again in a moment.');
  return new Error('Could not complete AI diagnosis. Please try again.');
}

/**
 * POST to Groq chat completions. On 429 retries once after 3 s; on 5xx retries once.
 */
async function groqFetch(messages, { json = false, temperature = 0.4, maxTokens = 1024 } = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
        temperature,
        max_tokens: maxTokens,
      }),
    });
    if (res.ok) return res;
    let errBody = '';
    try { const j = await res.clone().json(); errBody = j?.error?.message || JSON.stringify(j); } catch { errBody = await res.text().catch(() => ''); }
    console.error(`[groq] HTTP ${res.status} model=${GROQ_MODEL} attempt=${attempt}: ${errBody}`);
    if (attempt === 0 && (res.status === 429 || res.status >= 500)) {
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    const err = groqError(res.status);
    err.groqDetail = errBody;
    throw err;
  }
  throw groqError(429);
}

async function groqJson(messages, opts = {}) {
  const res  = await groqFetch(messages, { ...opts, json: true });
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? '{}';
  try { return JSON.parse(text); } catch { return {}; }
}

// ── Image helpers (shared between Groq vision and Gemini embed) ───────────────

/** Resolve any URL / S3 key / data-URI to { base64, mime }. */
async function toInlineData(url) {
  if (!url) return null;
  const dataMatch = /^data:(image\/[a-zA-Z+.-]+);base64,(.+)$/.exec(url);
  if (dataMatch) return { base64: dataMatch[2], mime: dataMatch[1] };
  let fetchUrl = url;
  if (!/^https?:\/\//i.test(url)) {
    try { fetchUrl = await getDownloadUrl(url); } catch { /* fall back to raw */ }
  }
  const res = await fetch(fetchUrl);
  if (!res.ok) throw new Error(`image ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { base64: buf.toString('base64'), mime: res.headers.get('content-type') || 'image/jpeg' };
}

// ── Gemini embedding (unchanged — Groq has no embedding model) ────────────────

export async function embedText(text) {
  if (!GEMINI_KEY || !text) return null;
  try {
    const res = await fetch(`${GEMINI}/${EMBED_MODEL}:embedContent?key=${GEMINI_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: `models/${EMBED_MODEL}`, content: { parts: [{ text }] }, outputDimensionality: EMBED_DIM }),
    });
    if (!res.ok) throw new Error(`embed ${res.status}`);
    const data = await res.json();
    return data?.embedding?.values ?? null;
  } catch { return null; }
}

/** Caption a crop photo using Groq vision (for training-sample indexing). */
export async function captionImage(imageUrl, crop = 'crop') {
  if (!aiConfigured || !imageUrl) return null;
  try {
    const img     = await toInlineData(imageUrl);
    const dataUrl = `data:${img.mime};base64,${img.base64}`;
    const prompt  = `Describe this ${crop} plant photo for disease retrieval in ONE sentence: leaf colour, lesion/spot pattern, pest signs, affected part. No preamble.`;
    const res  = await groqFetch(
      [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: dataUrl } }] }],
      { temperature: 0.2, maxTokens: 200 },
    );
    const data = await res.json();
    return (data?.choices?.[0]?.message?.content ?? '').trim() || null;
  } catch { return null; }
}

/**
 * Build a retrieval embedding: caption the photo (Groq), then embed the label+caption (Gemini).
 * Returns { caption, vector } or null when AI is unconfigured.
 */
export async function embedSample(imageUrl, label, crop) {
  if (!aiConfigured) return null;
  const caption = await captionImage(imageUrl, crop);
  const vector  = await embedText([label, caption].filter(Boolean).join('. '));
  return vector ? { caption, vector } : null;
}

/** Cosine similarity between two equal-length vectors (0..1 for normalised). */
export function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/**
 * Detect crop disease/pest from a photo or crop name alone.
 * `references` (from Train AI Doctor) are injected as multimodal few-shot context.
 * When no image is provided, a text-only Groq prompt is used.
 */
export async function diagnoseCrop({ crop, imageUrl, references = [], lang }) {
  assertConfigured();
  try {
    const langLine = lang === 'hi'
      ? ' Write the "symptoms" and "recommendation" values in Hindi (Devanagari script); keep JSON keys and disease/pathogen names in English.'
      : '';
    const outputInstruction = `Respond as strict JSON with keys: disease (string), pathogen (string), confidence (number 0-100), severity ("LOW"|"MEDIUM"|"HIGH"), symptoms (string), recommendation (string, 2-3 sentences of agronomic control advice).${langLine}`;

    if (!imageUrl) {
      const refContext = references.length
        ? ` Known conditions in our system for this crop: ${references.slice(0, 4).map((r) => r.disease).filter(Boolean).join(', ')}.`
        : '';
      const prompt = `You are an expert agronomy plant-pathologist. A farmer reports a problem with their ${crop} crop but has not provided a photo.${refContext} Based on common diseases affecting ${crop} in Indian agro-climatic conditions, diagnose the most likely disease or pest. ${outputInstruction}`;
      const j = await groqJson([{ role: 'user', content: prompt }], { temperature: 0.5, maxTokens: 512 });
      return {
        disease: j.disease ?? 'Unknown', pathogen: j.pathogen ?? null,
        confidence: Number(j.confidence) || 0, severity: SEVERITIES.includes(j.severity) ? j.severity : 'MEDIUM',
        symptoms: j.symptoms ?? null, recommendation: j.recommendation ?? null,
        source: 'groq-text',
      };
    }

    // Vision diagnosis: build a multimodal message with optional few-shot references.
    const queryImg     = await toInlineData(imageUrl);
    const queryDataUrl = `data:${queryImg.mime};base64,${queryImg.base64}`;
    const content      = [];
    let usedRefs       = 0;

    if (references.length) {
      content.push({ type: 'text', text: `You are an expert agronomy plant-pathologist. Below are labelled REFERENCE photos of known ${crop} crop conditions. Use them to ground your judgement.` });
      for (const ref of references.slice(0, 6)) {
        try {
          const img     = await toInlineData(ref.imageUrl);
          const dataUrl = `data:${img.mime};base64,${img.base64}`;
          content.push({ type: 'text', text: `Reference — ${ref.disease}${ref.pathogen ? ` (${ref.pathogen})` : ''}${ref.caption ? `: ${ref.caption}` : ''}` });
          content.push({ type: 'image_url', image_url: { url: dataUrl } });
          usedRefs += 1;
        } catch { /* skip unreadable reference */ }
      }
      content.push({ type: 'text', text: `Now diagnose THIS image of a ${crop} crop. Prefer a matching reference condition when applicable. ${outputInstruction}` });
    } else {
      content.push({ type: 'text', text: `You are an expert agronomy plant-pathologist. Diagnose this image of a ${crop} crop. ${outputInstruction}` });
    }
    content.push({ type: 'image_url', image_url: { url: queryDataUrl } });

    const j = await groqJson([{ role: 'user', content }], { temperature: 0.4, maxTokens: 512 });
    return {
      disease: j.disease ?? 'Unknown', pathogen: j.pathogen ?? null,
      confidence: Number(j.confidence) || 0, severity: SEVERITIES.includes(j.severity) ? j.severity : 'MEDIUM',
      symptoms: j.symptoms ?? null, recommendation: j.recommendation ?? null,
      source: usedRefs ? `groq+${usedRefs}ref` : 'groq',
    };
  } catch (err) {
    throw new Error(err?.message ?? 'AI diagnosis failed — please try again.');
  }
}

/** Generate a preventive/curative advisory using Groq. */
export async function generateAdvisory({ crop, disease, type }) {
  if (!aiConfigured) throw new Error('AI service is not configured. Please add a GROQ_API_KEY.');
  const prompt = `Write a concise ${type === 'PREVENTIVE' ? 'preventive' : 'curative'} agronomic advisory for ${disease || 'crop health'} affecting ${crop}, for a smallholder Indian farmer. Respond as strict JSON: { "title": string, "body": string (numbered, actionable, mention spray schedule and safety) }.`;
  const j = await groqJson([{ role: 'user', content: prompt }], { maxTokens: 768 });
  return { title: j.title ?? `Advisory for ${crop}`, body: j.body ?? '', source: 'groq' };
}

export function aiChannelStatus() {
  return { provider: 'groq', model: GROQ_MODEL, embeddingModel: EMBED_MODEL, configured: aiConfigured };
}
