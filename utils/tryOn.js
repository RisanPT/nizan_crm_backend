// "Preview on me" — turn a bride's selfie + her chosen look into a preview image.
//
// The AI vendor sits behind generateTryOn() so it is swappable and stubbable
// (same idea as utils/sms.js). Providers:
//   mock    – dev only: returns the selfie unchanged and flags it `demo`.
//   gemini  – Google Gemini image editing (Interactions API).
//
// Config (env):
//   TRYON_PROVIDER   mock | gemini   (unset: "mock" outside production, OFF in production)
//   GEMINI_API_KEY   required for gemini — use a PAID-tier key (free-tier data may be used
//                    by Google to improve products; check the current Gemini API terms).
//   TRYON_MODEL      default gemini-nano-banana-2.1
//   GEMINI_API_BASE  default https://generativelanguage.googleapis.com (override for tests)
//   TRYON_TIMEOUT_MS default 90000
//
// PRIVACY: the selfie is only ever held in memory for the duration of the call.

export class TryOnError extends Error {
  constructor(message, { status = 502, code = 'PROVIDER_ERROR' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const providerName = () => {
  const explicit = String(process.env.TRYON_PROVIDER || '').trim().toLowerCase();
  if (explicit) return explicit;
  return process.env.NODE_ENV === 'production' ? '' : 'mock';
};

/// True when a provider is configured well enough to be used.
export const tryOnConfigured = () => {
  const p = providerName();
  if (p === 'mock') return process.env.NODE_ENV !== 'production';
  if (p === 'gemini') return !!process.env.GEMINI_API_KEY;
  return false;
};

const CATEGORY_LABEL = { outfit: 'Outfit', jewellery: 'Jewellery', hair: 'Hair', makeup: 'Makeup' };
const CATEGORY_ORDER = ['outfit', 'jewellery', 'hair', 'makeup'];

/// The instruction sent to the model. It is deliberately strict about keeping
/// the person — and especially her skin tone — unchanged.
export const buildTryOnPrompt = ({ traditionName = '', fn = '', picks = [] } = {}) => {
  const byCat = new Map(picks.map((p) => [p.category, p.name]));
  const lines = CATEGORY_ORDER.filter((c) => byCat.has(c)).map(
    (c) => `- ${CATEGORY_LABEL[c]}: ${byCat.get(c)}`,
  );
  const occasion = [traditionName, fn].filter(Boolean).join(' ');
  return [
    `Edit this photograph of a bride-to-be into a realistic preview of her ${occasion || 'bridal'} look.`,
    '',
    'KEEP EXACTLY THE SAME PERSON: identical face, facial features, face shape, expression and age, ' +
      'and her natural skin tone and complexion. Do NOT lighten, darken, smooth, slim or otherwise ' +
      'beautify her face or body.',
    '',
    'Apply ONLY these styling choices and change nothing else:',
    ...lines,
    '',
    'Makeup shades must suit her own skin tone. If no hairstyle is listed, keep her current hair.',
    'Photorealistic, natural lighting, elegant portrait framing from head to waist, clean neutral ' +
      'background. No text, logos or watermarks.',
    'If the photo does not clearly show one adult person\'s face, do not invent one.',
  ].join('\n');
};

// ── Providers ────────────────────────────────────────────────────────────────

async function viaMock({ buffer, mime }) {
  // No AI: hand back the selfie so the whole flow can be exercised in dev.
  return { buffer, mime, provider: 'mock', model: 'mock', demo: true };
}

const asBuffer = (b64) => Buffer.from(String(b64), 'base64');

/// Pulls the generated image out of an Interactions API response. Tolerates the
/// documented `steps[].content[]` blocks plus the convenience/legacy shapes.
const extractGeminiImage = (json) => {
  for (const step of json?.steps ?? []) {
    if (step?.type && step.type !== 'model_output') continue;
    for (const block of step?.content ?? []) {
      if (block?.type === 'image' && block.data) {
        return { buffer: asBuffer(block.data), mime: block.mime_type || 'image/png' };
      }
    }
  }
  if (json?.output_image?.data) {
    return { buffer: asBuffer(json.output_image.data), mime: json.output_image.mime_type || 'image/png' };
  }
  // generateContent-style fallback.
  for (const cand of json?.candidates ?? []) {
    for (const part of cand?.content?.parts ?? []) {
      const inline = part?.inlineData ?? part?.inline_data;
      if (inline?.data) {
        return { buffer: asBuffer(inline.data), mime: inline.mimeType || inline.mime_type || 'image/png' };
      }
    }
  }
  return null;
};

async function viaGemini({ buffer, mime, prompt }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new TryOnError('Preview is not configured.', { status: 503, code: 'TRYON_UNAVAILABLE' });
  const base = (process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  const model = process.env.TRYON_MODEL || 'gemini-nano-banana-2.1';
  const timeoutMs = Number.parseInt(process.env.TRYON_TIMEOUT_MS, 10) || 90_000;

  let res;
  try {
    res = await fetch(`${base}/v1beta/interactions`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        input: [
          { type: 'text', text: prompt },
          { type: 'image', mime_type: mime, data: buffer.toString('base64') },
        ],
        // Don't keep the request/response (it contains her face) on Google's side.
        store: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new TryOnError(
      timedOut ? 'The preview took too long. Please try again.' : 'Could not reach the preview service.',
      { status: 504, code: timedOut ? 'TIMEOUT' : 'UNREACHABLE' },
    );
  }

  if (!res.ok) {
    // Log the vendor's detail server-side only; never surface it (or the key).
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    console.error(`[tryon] gemini HTTP ${res.status}: ${detail}`);
    if (res.status === 429) {
      throw new TryOnError('Previews are busy right now. Please try again in a few minutes.', { status: 503, code: 'PROVIDER_BUSY' });
    }
    if (res.status === 400) {
      throw new TryOnError('We couldn\'t use that photo. Try a clear, front-facing photo in good light.', { status: 422, code: 'BAD_INPUT' });
    }
    throw new TryOnError('The preview service had a problem. Please try again.', { status: 502, code: 'PROVIDER_ERROR' });
  }

  const json = await res.json().catch(() => null);
  const image = extractGeminiImage(json);
  if (!image || !image.buffer.length) {
    const failed = json?.status === 'failed' || (json?.errors ?? []).length > 0;
    console.error(`[tryon] gemini returned no image (status=${json?.status}, errors=${JSON.stringify(json?.errors ?? [])})`);
    throw new TryOnError(
      failed
        ? 'We couldn\'t create a preview from that photo. Try a clear, front-facing photo with no filters.'
        : 'No preview was created. Try a clearer, front-facing photo in good light.',
      { status: 422, code: 'NO_IMAGE' },
    );
  }
  return { ...image, provider: 'gemini', model, demo: false };
}

const PROVIDERS = { mock: viaMock, gemini: viaGemini };

/// @returns {{buffer:Buffer, mime:string, provider:string, model:string, demo:boolean}}
export const generateTryOn = async ({ buffer, mime, prompt }) => {
  const impl = PROVIDERS[providerName()];
  if (!impl || !tryOnConfigured()) {
    throw new TryOnError('Face preview isn\'t available yet.', { status: 503, code: 'TRYON_UNAVAILABLE' });
  }
  return impl({ buffer, mime, prompt });
};
