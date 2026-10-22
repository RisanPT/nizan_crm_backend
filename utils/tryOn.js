import fs from 'fs';
import path from 'path';
import os from 'os';

// "Preview on me" — turn a bride's selfie + her chosen look into a preview image.
//
// Providers:
//   faceswap     – Photorealistic face swap: blends bride's real face onto real studio bridal template photos.
//   pollinations – Free AI image generation (Flux/Sana), zero configuration/API key required.
//   gemini       – Google Gemini / Imagen 3 (free or paid tier from Google AI Studio).
//   huggingface  – Hugging Face Inference API (free tier with HF_TOKEN).
//   cloudflare   – Cloudflare Workers AI (10,000 neurons/day free tier).
//   mock         – dev only: returns the selfie unchanged and flags it `demo`.
//
// Config (env):
//   TRYON_PROVIDER   faceswap | pollinations | gemini | huggingface | cloudflare | mock (default: faceswap)
//   TRYON_DAILY_LIMIT default 5
//   FACESWAP_SPACE   default felixrosberg/face-swap
//   TRYON_TIMEOUT_MS default 60000
//
// PRIVACY: the selfie is only ever held in memory / temporary scratch for the duration of the call.

export class TryOnError extends Error {
  constructor(message, { status = 502, code = 'PROVIDER_ERROR' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const providerName = () => {
  const explicit = String(process.env.TRYON_PROVIDER || '').trim().toLowerCase();
  if (explicit && explicit !== 'auto') return explicit;
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.HF_TOKEN) return 'huggingface';
  if (process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID) return 'cloudflare';
  // Default: Photorealistic Face-Swap onto real studio bridal templates
  return 'faceswap';
};

/// True when a provider is configured well enough to be used.
export const tryOnConfigured = () => {
  const p = providerName();
  if (p === 'faceswap') return true;
  if (p === 'mock') return true;
  if (p === 'pollinations') return true;
  if (p === 'gemini') return !!process.env.GEMINI_API_KEY;
  if (p === 'huggingface') return !!process.env.HF_TOKEN;
  if (p === 'cloudflare') return !!(process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID);
  return false;
};

/// Resolves the studio's actual photograph matching the bride's tradition and selected outfit.
export const resolveTemplateFile = ({ tradition = '', picks = [] } = {}) => {
  const outfitPick = picks.find((p) => p.category === 'outfit')?.name || '';
  const oLower = outfitPick.toLowerCase();
  const tLower = tradition.toLowerCase();

  // Match outfit specific photos
  if (oLower.includes('red') && (oLower.includes('kanjeevaram') || tLower.includes('south'))) return 'si_out_red.jpg';
  if (oLower.includes('tissue') || (oLower.includes('pastel') && tLower.includes('south'))) return 'si_out_pastel.jpg';
  if (oLower.includes('half') || oLower.includes('pavadai')) return 'si_out_half.jpg';

  if (oLower.includes('kasavu') && oLower.includes('maroon')) return 'ml_out_maroon.jpg';
  if (oLower.includes('kasavu')) return 'ml_out_kasavu.jpg';
  if (oLower.includes('pastel') && tLower.includes('malayali')) return 'ml_out_pastel.jpg';

  if (oLower.includes('gharara') || (oLower.includes('maroon') && tLower.includes('muslim'))) return 'mu_out_maroon.jpg';
  if (oLower.includes('ivory') || oLower.includes('sharara')) return 'mu_out_ivory.jpg';
  if (oLower.includes('anarkali') || (oLower.includes('pastel') && tLower.includes('muslim'))) return 'mu_out_pastel.jpg';

  if (oLower.includes('haldi')) return 'ni_out_haldi.jpg';
  if (oLower.includes('lehenga') && oLower.includes('pastel')) return 'ni_out_pastel.jpg';
  if (oLower.includes('lehenga') || tLower.includes('north')) return 'ni_out_red.jpg';

  // Fallbacks based on cultural tradition
  if (tLower.includes('malayali') || tLower.includes('kerala')) return 'ml_out_kasavu.jpg';
  if (tLower.includes('muslim') || tLower.includes('nikah')) return 'mu_out_maroon.jpg';
  if (tLower.includes('north')) return 'ni_out_red.jpg';

  // Default: South Indian Kanjeevaram red & gold
  return 'si_out_red.jpg';
};

const CATEGORY_LABEL = { outfit: 'Outfit', jewellery: 'Jewellery', hair: 'Hair', makeup: 'Makeup' };
const CATEGORY_ORDER = ['outfit', 'jewellery', 'hair', 'makeup'];

/// Instruction prompt preserving natural face, identity and skin tone.
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

/// Visual description prompt tailored for diffusion models (Flux, Sana, SDXL, Imagen 3).
export const buildVisualPrompt = ({ traditionName = '', fn = '', picks = [] } = {}) => {
  const byCat = new Map(picks.map((p) => [p.category, p.name]));
  const occasion = [traditionName, fn].filter(Boolean).join(' ') || 'wedding';
  const outfit = byCat.get('outfit') ? `traditional bridal attire (${byCat.get('outfit')})` : 'exquisite bridal wedding outfit';
  const jewellery = byCat.get('jewellery') ? `ornate matching jewellery set (${byCat.get('jewellery')})` : 'traditional bridal gold jewellery';
  const hair = byCat.get('hair') ? `styled hair (${byCat.get('hair')})` : 'elegant bridal hairstyle';
  const makeup = byCat.get('makeup') ? `flawless bridal makeup (${byCat.get('makeup')})` : 'professional radiant bridal makeup';

  return `Stunning ultra-realistic bridal portrait of a beautiful bride, ${occasion} ceremony, wearing ${outfit}, adorned with ${jewellery}, styled with ${hair}, wearing ${makeup}, authentic natural skin tone, photorealistic soft studio lighting, 85mm lens portrait, highly detailed, 8k resolution, elegant bokeh neutral background.`;
};

// ── Providers ────────────────────────────────────────────────────────────────

async function viaMock({ buffer, mime }) {
  // Hand back the selfie so the whole flow can be exercised in dev.
  return { buffer, mime, provider: 'mock', model: 'mock', demo: true };
}

const asBuffer = (b64) => Buffer.from(String(b64), 'base64');

/// Free AI generation via Pollinations (no API key required).
async function viaPollinations({ visualPrompt, prompt }) {
  const textPrompt = visualPrompt || prompt;
  const timeoutMs = Number.parseInt(process.env.TRYON_TIMEOUT_MS, 10) || 90_000;
  const seed = Math.floor(Math.random() * 1_000_000);
  const encoded = encodeURIComponent(textPrompt);
  const model = process.env.TRYON_MODEL || 'turbo';
  const width = Number.parseInt(process.env.TRYON_WIDTH, 10) || 512;
  const height = Number.parseInt(process.env.TRYON_HEIGHT, 10) || 768;
  const pollenKey = process.env.POLLEN_KEY ? `&key=${encodeURIComponent(process.env.POLLEN_KEY)}` : '';
  const url = `https://image.pollinations.ai/prompt/${encoded}?model=${encodeURIComponent(model)}&width=${width}&height=${height}&nologo=true&seed=${seed}${pollenKey}`;

  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new TryOnError(
      timedOut ? 'The preview generation took too long. Please try again.' : 'Could not reach the preview service.',
      { status: 504, code: timedOut ? 'TIMEOUT' : 'UNREACHABLE' },
    );
  }

  if (res.status === 402 || res.status === 429) {
    const json = await res.json().catch(() => null);
    const retryMsg = json?.error?.message || 'Free generation is momentarily busy. Please try again in 30 seconds.';
    throw new TryOnError(retryMsg, { status: 429, code: 'RATE_LIMIT' });
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    console.error(`[tryon] pollinations HTTP ${res.status}: ${detail}`);
    throw new TryOnError('The preview service had a temporary problem. Please try again.', { status: 502, code: 'PROVIDER_ERROR' });
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('image')) {
    const errText = await res.text().catch(() => '');
    console.error(`[tryon] pollinations non-image response: ${errText.slice(0, 200)}`);
    throw new TryOnError('Could not generate bridal preview image.', { status: 502, code: 'NO_IMAGE' });
  }

  const arrayBuf = await res.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuf),
    mime: contentType.split(';')[0].trim() || 'image/jpeg',
    provider: 'pollinations',
    model,
    demo: false,
  };
}

/// Hugging Face serverless inference (free tier with HF_TOKEN).
async function viaHuggingFace({ visualPrompt, prompt }) {
  const token = process.env.HF_TOKEN;
  if (!token) throw new TryOnError('Hugging Face token is missing.', { status: 503, code: 'TRYON_UNAVAILABLE' });
  const model = process.env.TRYON_HF_MODEL || 'black-forest-labs/FLUX.1-schnell';
  const timeoutMs = Number.parseInt(process.env.TRYON_TIMEOUT_MS, 10) || 60_000;

  let res;
  try {
    res = await fetch(`https://router.huggingface.co/hf-inference/models/${model}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ inputs: visualPrompt || prompt }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new TryOnError(
      timedOut ? 'The preview generation took too long.' : 'Could not reach Hugging Face.',
      { status: 504, code: timedOut ? 'TIMEOUT' : 'UNREACHABLE' },
    );
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    console.error(`[tryon] huggingface HTTP ${res.status}: ${detail}`);
    if (res.status === 429) {
      throw new TryOnError('AI models are busy right now. Please try again shortly.', { status: 429, code: 'PROVIDER_BUSY' });
    }
    throw new TryOnError('Hugging Face preview service error.', { status: 502, code: 'PROVIDER_ERROR' });
  }

  const arrayBuf = await res.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuf),
    mime: res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/jpeg',
    provider: 'huggingface',
    model,
    demo: false,
  };
}

/// Cloudflare Workers AI (10,000 neurons/day free tier).
async function viaCloudflare({ visualPrompt, prompt }) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) {
    throw new TryOnError('Cloudflare AI credentials missing.', { status: 503, code: 'TRYON_UNAVAILABLE' });
  }
  const model = process.env.TRYON_CF_MODEL || '@cf/black-forest-labs/flux-1-schnell';
  const timeoutMs = Number.parseInt(process.env.TRYON_TIMEOUT_MS, 10) || 60_000;

  let res;
  try {
    res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prompt: visualPrompt || prompt }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new TryOnError(
      timedOut ? 'Cloudflare AI generation timed out.' : 'Could not reach Cloudflare AI.',
      { status: 504, code: timedOut ? 'TIMEOUT' : 'UNREACHABLE' },
    );
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    console.error(`[tryon] cloudflare HTTP ${res.status}: ${detail}`);
    throw new TryOnError('Cloudflare preview service error.', { status: 502, code: 'PROVIDER_ERROR' });
  }

  const arrayBuf = await res.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuf),
    mime: res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/jpeg',
    provider: 'cloudflare',
    model,
    demo: false,
  };
}

/// Google Gemini / Imagen 3 generation.
async function viaGemini({ buffer, mime, prompt, visualPrompt }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new TryOnError('Preview is not configured.', { status: 503, code: 'TRYON_UNAVAILABLE' });
  const base = (process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  const model = process.env.TRYON_MODEL || 'imagen-3.0-generate-002';
  const timeoutMs = Number.parseInt(process.env.TRYON_TIMEOUT_MS, 10) || 60_000;

  // 1. Imagen 3 predict endpoint
  if (model.includes('imagen')) {
    let res;
    try {
      res = await fetch(`${base}/v1beta/models/${model}:predict?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instances: [{ prompt: visualPrompt || prompt }],
          parameters: {
            sampleCount: 1,
            aspectRatio: '3:4',
            personGeneration: 'ALLOW_ADULT',
          },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      throw new TryOnError(
        timedOut ? 'The preview took too long.' : 'Could not reach the preview service.',
        { status: 504, code: timedOut ? 'TIMEOUT' : 'UNREACHABLE' },
      );
    }

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      console.error(`[tryon] imagen HTTP ${res.status}: ${detail}`);
      if (res.status === 429) {
        throw new TryOnError('Previews are busy right now. Please try again shortly.', { status: 503, code: 'PROVIDER_BUSY' });
      }
      throw new TryOnError('The preview service had a problem. Please try again.', { status: 502, code: 'PROVIDER_ERROR' });
    }

    const json = await res.json().catch(() => null);
    const pred = json?.predictions?.[0];
    if (pred?.bytesBase64Encoded) {
      return {
        buffer: asBuffer(pred.bytesBase64Encoded),
        mime: pred.mimeType || 'image/jpeg',
        provider: 'gemini',
        model,
        demo: false,
      };
    }
  }

  // 2. Multimodal fallback (v1beta/interactions)
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
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    console.error(`[tryon] gemini HTTP ${res.status}: ${detail}`);
    throw new TryOnError('The preview service had a problem. Please try again.', { status: 502, code: 'PROVIDER_ERROR' });
  }

  const json = await res.json().catch(() => null);
  const image = extractGeminiImage(json);
  if (!image || !image.buffer.length) {
    throw new TryOnError('No preview was created. Try a clearer photo in good light.', { status: 422, code: 'NO_IMAGE' });
  }
  return { ...image, provider: 'gemini', model, demo: false };
}

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

/// Photorealistic Face-Swap onto the studio's actual bridal photography templates.
async function viaFaceSwap({ buffer, tradition = '', picks = [] }) {
  const templateFilename = resolveTemplateFile({ tradition, picks });
  const templatePath = path.resolve('assets/looks', templateFilename);
  if (!fs.existsSync(templatePath)) {
    console.error(`[tryon] Template file missing: ${templatePath}`);
    throw new TryOnError('Bridal template not found for this look.', { status: 500, code: 'TEMPLATE_MISSING' });
  }

  const tmpSelfie = path.join(os.tmpdir(), `bride_selfie_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
  try {
    fs.writeFileSync(tmpSelfie, buffer);

    const timeoutMs = Number.parseInt(process.env.TRYON_TIMEOUT_MS, 10) || 60_000;
    const space = process.env.FACESWAP_SPACE || 'felixrosberg/face-swap';
    console.log(`[tryon] Running photorealistic face swap via ${space} using template ${templateFilename}...`);

    const { Client, handle_file } = await import('@gradio/client');
    const app = await Client.connect(space);
    const result = await app.predict('/run_inference', [
      handle_file(templatePath),
      handle_file(tmpSelfie),
      100, // anonymization/swap ratio
      100, // adv defense
      [],  // settings
    ]);

    const outputUrl = result?.data?.[0]?.url;
    if (!outputUrl) {
      throw new TryOnError('Could not generate face-swapped preview.', { status: 502, code: 'NO_IMAGE' });
    }

    const res = await fetch(outputUrl, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      throw new TryOnError('Failed to download preview result.', { status: 502, code: 'DOWNLOAD_FAILED' });
    }

    const arrayBuf = await res.arrayBuffer();
    const contentType = res.headers.get('content-type') || 'image/webp';

    return {
      buffer: Buffer.from(arrayBuf),
      mime: contentType.split(';')[0].trim() || 'image/webp',
      provider: 'faceswap',
      model: space,
      demo: false,
    };
  } catch (err) {
    console.error('[tryon] face swap error:', err.message);
    throw new TryOnError(err.message || 'Face swap failed. Please try again.', { status: 502, code: 'PROVIDER_ERROR' });
  } finally {
    if (fs.existsSync(tmpSelfie)) {
      try { fs.unlinkSync(tmpSelfie); } catch (_) {}
    }
  }
}

const PROVIDERS = {
  faceswap: viaFaceSwap,
  mock: viaMock,
  pollinations: viaPollinations,
  huggingface: viaHuggingFace,
  cloudflare: viaCloudflare,
  gemini: viaGemini,
};

/// @returns {{buffer:Buffer, mime:string, provider:string, model:string, demo:boolean}}
export const generateTryOn = async ({ buffer, mime, tradition, traditionName, fn, picks, prompt, visualPrompt }) => {
  const pName = providerName();
  const impl = PROVIDERS[pName];
  if (!impl || !tryOnConfigured()) {
    throw new TryOnError('Face preview isn\'t available yet.', { status: 503, code: 'TRYON_UNAVAILABLE' });
  }
  try {
    return await impl({ buffer, mime, tradition, traditionName, fn, picks, prompt, visualPrompt });
  } catch (err) {
    // In dev mode, if external AI had a network outage or 429, fall back to mock so dev isn't blocked
    if (process.env.NODE_ENV !== 'production' && pName !== 'mock' && err?.status !== 400 && err?.status !== 422) {
      console.warn(`[tryon] ${pName} failed (${err.message}). Falling back to dev mock preview.`);
      return viaMock({ buffer, mime });
    }
    throw err;
  }
};

