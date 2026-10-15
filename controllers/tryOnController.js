import mongoose from 'mongoose';
import ClientUser from '../models/ClientUser.js';
import TryOnPreview, { TRYON_RETENTION_DAYS } from '../models/TryOnPreview.js';
import { sniffImageMime } from '../middleware/selfieUpload.js';
import { generateTryOn, buildTryOnPrompt, tryOnConfigured, TryOnError } from '../utils/tryOn.js';

// "Preview on me" for the client bridal app. All routes are behind protectClient.
//
// Privacy model:
//  - explicit, versioned consent is required before any selfie is accepted;
//  - the selfie is held in memory only and discarded after the provider call;
//  - the generated preview is stored in OUR database, served only to its owner,
//    auto-deleted after TRYON_RETENTION_DAYS, and deletable any time;
//  - withdrawing consent deletes every preview.

/// Bump when the consent wording changes — everyone is asked again.
export const CONSENT_VERSION = '2026-10';
const MAX_STORED = 12;
const dailyLimit = () => Math.max(1, Number.parseInt(process.env.TRYON_DAILY_LIMIT, 10) || 3);

const today = () => new Date().toISOString().slice(0, 10);
const short = (v, n = 120) => String(v ?? '').trim().slice(0, n);
const hasConsent = (c) => !!c.faceConsent?.at && c.faceConsent?.version === CONSENT_VERSION;
const usedToday = (c) => (c.tryOnUsage?.day === today() ? c.tryOnUsage.count || 0 : 0);

// One generation at a time per client — a double-tap shouldn't cost two calls.
const inFlight = new Set();

const view = (p) => ({
  id: String(p._id),
  tradition: p.tradition,
  traditionName: p.traditionName,
  function: p.function,
  picks: p.picks || [],
  createdAt: p.createdAt,
  demo: !!p.demo,
});

const statusPayload = async (client) => {
  const previews = await TryOnPreview.find({ clientUserId: client._id }).sort({ createdAt: -1 }).lean();
  const used = usedToday(client);
  return {
    available: tryOnConfigured(),
    consent: hasConsent(client),
    consentVersion: CONSENT_VERSION,
    dailyLimit: dailyLimit(),
    remainingToday: Math.max(0, dailyLimit() - used),
    retentionDays: TRYON_RETENTION_DAYS,
    previews: previews.map(view),
  };
};

// @route GET /api/client/tryon
export const getTryOnStatus = async (req, res) => {
  try {
    res.json(await statusPayload(req.client));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route POST /api/client/tryon/consent  { accept: true, version }
export const grantConsent = async (req, res) => {
  try {
    if (req.body?.accept !== true) {
      return res.status(400).json({ message: 'Consent is required to create previews.' });
    }
    if (req.body?.version !== CONSENT_VERSION) {
      return res.status(409).json({ message: 'The consent wording was updated. Please review it and agree again.' });
    }
    req.client.faceConsent = { at: new Date(), version: CONSENT_VERSION };
    await req.client.save();
    res.json(await statusPayload(req.client));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route DELETE /api/client/tryon/consent — withdraw consent AND delete every preview.
export const withdrawConsent = async (req, res) => {
  try {
    await TryOnPreview.deleteMany({ clientUserId: req.client._id });
    req.client.faceConsent = { at: null, version: '' };
    await req.client.save();
    res.json(await statusPayload(req.client));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route POST /api/client/tryon  multipart { selfie, tradition, traditionName, function, picks(JSON) }
export const createPreview = async (req, res) => {
  const clientId = String(req.client._id);
  try {
    if (!tryOnConfigured()) {
      return res.status(503).json({ message: 'Face preview isn\'t available yet.', code: 'TRYON_UNAVAILABLE' });
    }
    if (!hasConsent(req.client)) {
      return res.status(403).json({ message: 'Please agree to the photo consent first.', code: 'CONSENT_REQUIRED' });
    }
    if (!req.file) return res.status(400).json({ message: 'Please add a photo of yourself.' });

    const realMime = sniffImageMime(req.file.buffer);
    if (!realMime) return res.status(415).json({ message: 'Please use a JPEG, PNG or WebP photo.' });

    // What to apply.
    let picks = [];
    try {
      const parsed = JSON.parse(req.body.picks || '[]');
      picks = (Array.isArray(parsed) ? parsed : [])
        .slice(0, 6)
        .map((p) => ({ category: short(p?.category, 30), name: short(p?.name, 120) }))
        .filter((p) => p.category && p.name);
    } catch {
      /* falls through to the empty check */
    }
    const fn = short(req.body.function, 60);
    if (!fn || picks.length === 0) {
      return res.status(400).json({ message: 'Choose at least one look for this function first.' });
    }

    if (inFlight.has(clientId)) {
      return res.status(429).json({ message: 'A preview is already being created. Please wait.', code: 'IN_PROGRESS' });
    }
    const stored = await TryOnPreview.countDocuments({ clientUserId: req.client._id });
    if (stored >= MAX_STORED) {
      return res.status(409).json({ message: 'You have the maximum number of previews. Delete one to make room.', code: 'STORAGE_FULL' });
    }
    if (usedToday(req.client) >= dailyLimit()) {
      return res.status(429).json({
        message: `You've used today's ${dailyLimit()} previews. Try again tomorrow.`,
        code: 'DAILY_LIMIT',
      });
    }

    inFlight.add(clientId);
    let result;
    try {
      // Count the attempt up front (so retries can't dodge the cap); refund below
      // if the failure was ours.
      const day = today();
      req.client.tryOnUsage = { day, count: usedToday(req.client) + 1 };
      await req.client.save();
      try {
        result = await generateTryOn({
          buffer: req.file.buffer,
          mime: realMime,
          prompt: buildTryOnPrompt({
            traditionName: short(req.body.traditionName, 80),
            fn,
            picks,
          }),
        });
      } catch (err) {
        req.client.tryOnUsage = { day, count: Math.max(0, usedToday(req.client) - 1) };
        await req.client.save().catch(() => {});
        throw err;
      }
    } finally {
      inFlight.delete(clientId); // always release, even if save() throws
    }

    const preview = await TryOnPreview.create({
      clientUserId: req.client._id,
      tradition: short(req.body.tradition, 60),
      traditionName: short(req.body.traditionName, 80),
      function: fn,
      picks,
      mime: result.mime,
      bytes: result.buffer.length,
      image: result.buffer,
      provider: result.provider,
      model: result.model,
      demo: result.demo,
    });
    res.status(201).json({ preview: view(preview), remainingToday: Math.max(0, dailyLimit() - usedToday(req.client)) });
  } catch (error) {
    if (error instanceof TryOnError) {
      return res.status(error.status).json({ message: error.message, code: error.code });
    }
    console.error('createPreview failed:', error.message);
    res.status(500).json({ message: 'Could not create the preview. Please try again.' });
  }
};

// @route GET /api/client/tryon/:id/image — the owner only, never cached.
export const getPreviewImage = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Not found' });
    const p = await TryOnPreview.findOne({ _id: req.params.id, clientUserId: req.client._id }).select('+image mime');
    if (!p) return res.status(404).json({ message: 'Not found' });
    res.set({
      'Content-Type': p.mime || 'image/png',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.send(p.image);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route DELETE /api/client/tryon/:id
export const deletePreview = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Not found' });
    const r = await TryOnPreview.deleteOne({ _id: req.params.id, clientUserId: req.client._id });
    if (!r.deletedCount) return res.status(404).json({ message: 'Not found' });
    res.json(await statusPayload(req.client));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
