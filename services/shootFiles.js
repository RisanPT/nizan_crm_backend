import { Readable } from 'node:stream';

// The PDFs of a shoot (moodboard and storyboard documents), kept in Cloudinary as raw files like Company Reports. They are only ever sent
// back through the server (controllers/marketingPortfolioController.js — login and Marketing access checked); the stored address is not
// handed out. Cloudinary's settings are loaded only when a file is really stored or removed (config/cloudinary.js reads .env), and tests
// put their own store in its place ([_setShootFileStore]) — so a test never reaches Cloudinary.

let store = null;
export const _setShootFileStore = (s) => {
  store = s ?? null;
};
const cloud = async () => (await import('../config/cloudinary.js')).cloudinary;

/** The name Cloudinary files it under: plain letters, digits, - and _ (the name shown in the app is kept apart, as it was). */
export const storageName = (name) =>
  String(name ?? '')
    .replace(/\.pdf$/i, '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 80) || 'document';

/** Keeps [buffer] → { url, id }. */
export const putPdf = async (buffer, name) => {
  if (store) return store.put(buffer, name);
  const c = await cloud();
  const r = await new Promise((resolve, reject) => {
    const s = c.uploader.upload_stream({ resource_type: 'raw', folder: 'team_n_crm/shoot_docs', use_filename: true, unique_filename: true, filename_override: `${storageName(name)}.pdf` }, (e, res) => (e ? reject(e) : resolve(res)));
    Readable.from(buffer).pipe(s);
  });
  return { url: r.secure_url, id: r.public_id };
};

const fetched = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`The stored PDF could not be fetched (HTTP ${r.status}${r.headers.get('x-cld-error') ? ` — ${r.headers.get('x-cld-error')}` : ''}).`);
  return Buffer.from(await r.arrayBuffer());
};

/**
 * The bytes of a kept file. Read through Cloudinary's SIGNED download (made with the API key, on the server only, good for 5 minutes):
 * a Cloudinary account that does not deliver PDFs by their plain link — the default for new accounts, "deny or ACL failure" (401) — still
 * hands them over this way. The plain link is the fallback (a file kept before [id] was recorded).
 */
export const getPdf = async (url, id) => {
  if (store) return store.get(url, id);
  if (id) {
    const c = await cloud();
    const signed = c.utils.private_download_url(id, '', { resource_type: 'raw', type: 'upload', expires_at: Math.floor(Date.now() / 1000) + 300 });
    try {
      return await fetched(signed);
    } catch (e) {
      if (!url) throw e;
    }
  }
  return fetched(url);
};

/** Lets a kept file go (a failure is only logged — the shoot no longer lists it either way). */
export const removePdf = async (id) => {
  if (!id) return;
  try {
    if (store) return await store.remove(id);
    await (await cloud()).uploader.destroy(id, { resource_type: 'raw' });
  } catch (e) {
    console.error('Could not remove a shoot PDF from storage:', e?.message ?? e);
  }
};
