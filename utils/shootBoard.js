// The Shoot Planner's moodboard, logistics and milestone dates (pure — tests/shootBoard.test.js). The controller
// (controllers/marketingPortfolioController.js) saves what these return.
//
//  • Moodboard (and the Camera Movement plan, the same kind of board): pictures (uploaded from the phone or computer, or a link to a
//    picture), videos (a video file, or a YouTube / Instagram reel / Vimeo / TikTok page) and plain links (Pinterest, a Drive folder).
//    Each is kept once (by its link), with a label, who added it and when. At most MAX_MOODBOARD.
//  • Logistics: the crew's call time, a map link, a checklist of what to bring or arrange (each ticked by whoever did it), and notes.
//  • Milestones: moving the shoot day moves the milestones not yet done by the same number of days (done ones keep their dates).
//  • Storyboard: each frame keeps a KEY of its own, so on the shoot day a frame is ticked "shot" (who, when) on its own — a tick never
//    undoes another person's — and an edit of the frames (text, order, picture) keeps the ticks of the frames that stay.
//  • Checklist: a line is ticked on its own too (by its text — a checklist holds each line once).

import { httpUrl } from './marketingSocialsInput.js';

export const MAX_MOODBOARD = 60;
export const MAX_CHECKLIST = 40;

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const fail = (message, field) => ({ ok: false, message, field });
const DAY_MS = 24 * 60 * 60 * 1000;

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|heic|heif|avif|bmp)$/i;
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|avi|mkv)$/i;

/** A video page on a video site — YouTube, an Instagram reel, Vimeo, TikTok — shown as a video (it plays in its own app). */
const isVideoPage = (u, path) => {
  const host = u.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
  if (host === 'youtu.be') return path.length > 1;
  if (host === 'youtube.com' || host === 'music.youtube.com') return /^\/(watch|shorts\/|live\/|embed\/)/.test(path);
  if (host === 'instagram.com') return /^\/(reels?|tv)\//.test(path) || /^\/[^/]+\/reels?\//.test(path);
  if (host === 'vimeo.com' || host === 'player.vimeo.com') return /\/\d+/.test(path);
  if (host === 'tiktok.com' || host === 'vm.tiktok.com') return /\/video\//.test(path) || host === 'vm.tiktok.com';
  return false;
};

/** What a moodboard link shows: 'image' (a picture the screen can show), 'video', or 'link' (anything else — opened outside). */
export const moodboardKind = (url) => {
  let u;
  try {
    u = new URL(url);
  } catch {
    return 'link';
  }
  const path = decodeURIComponent(u.pathname);
  if (/(^|\.)cloudinary\.com$/i.test(u.hostname) && /\/(image)\/upload\//.test(path)) return 'image';
  if (/(^|\.)cloudinary\.com$/i.test(u.hostname) && /\/(video)\/upload\//.test(path)) return 'video';
  if (/^i\.pinimg\.com$/i.test(u.hostname) || /^images\.unsplash\.com$/i.test(u.hostname)) return 'image';
  if (IMAGE_EXT.test(path)) return 'image';
  if (VIDEO_EXT.test(path)) return 'video';
  if (isVideoPage(u, path)) return 'video';
  return 'link';
};

/** Moodboard items from a request: [{ url, label }] → checked [{ url, label, kind }], or why not. */
export const cleanMoodboardItems = (items) => {
  if (!Array.isArray(items) || !items.length) return fail('Add a picture or a link.', 'items');
  const out = [];
  for (const it of items) {
    const url = httpUrl(typeof it === 'string' ? it : it?.url);
    if (!url) return fail('Each moodboard item must be a link starting with https://.', 'items');
    out.push({ url, label: str(typeof it === 'string' ? '' : it?.label, 120), kind: moodboardKind(url) });
  }
  return { ok: true, value: out };
};

/**
 * [existing] with [items] added at the end (a link already on the board is not added twice) — refused past MAX_MOODBOARD.
 * → { ok, list, added, skipped } or { ok: false, message }
 */
export const addToMoodboard = (existing, items, { byName = '', now = new Date(), max = MAX_MOODBOARD, what = 'A moodboard' } = {}) => {
  const list = [...(existing ?? [])];
  const have = new Set(list.map((r) => r.url));
  let added = 0;
  let skipped = 0;
  for (const it of items) {
    if (have.has(it.url)) {
      skipped += 1;
      continue;
    }
    have.add(it.url);
    list.push({ url: it.url, label: it.label ?? '', kind: it.kind ?? moodboardKind(it.url), addedByName: byName, addedAt: now });
    added += 1;
  }
  if (list.length > max) return fail(`${what} holds up to ${max} pictures and links — this would make ${list.length}. Remove some first.`, 'items');
  return { ok: true, list, added, skipped };
};

/** [existing] without the item at [url]; { list, removed }. */
export const removeFromMoodboard = (existing, url) => {
  const list = (existing ?? []).filter((r) => r.url !== url);
  return { list, removed: (existing ?? []).length - list.length };
};

/** A label changed (the rest kept). */
export const relabelMoodboard = (existing, url, label) => (existing ?? []).map((r) => (r.url === url ? { ...r, label: str(label, 120) } : r));

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The logistics from a request — only what was sent changes; a checklist item keeps who ticked it when its tick does not change. */
export const cleanLogistics = (b = {}, current = {}, { byName = '', now = new Date() } = {}) => {
  const out = { callTime: current.callTime ?? '', mapUrl: current.mapUrl ?? '', notes: current.notes ?? '', checklist: current.checklist ?? [] };
  if (b.callTime !== undefined) {
    const t = str(b.callTime, 5);
    if (t && !HHMM.test(t)) return fail('The call time is HH:MM, like 07:30.', 'callTime');
    out.callTime = t;
  }
  if (b.mapUrl !== undefined) {
    const raw = str(b.mapUrl, 1000);
    const u = httpUrl(raw);
    if (raw && !u) return fail('The map link must start with https://.', 'mapUrl');
    out.mapUrl = u;
  }
  if (b.notes !== undefined) out.notes = str(b.notes, 1000);
  if (b.checklist !== undefined) {
    if (!Array.isArray(b.checklist)) return fail('The checklist must be a list.', 'checklist');
    const seen = new Set();
    // each line once (a line is ticked by its text): the same line twice keeps the first
    const items = b.checklist
      .map((c) => ({ text: str(typeof c === 'string' ? c : c?.text, 160), done: typeof c === 'object' && c?.done === true }))
      .filter((c) => c.text && !seen.has(c.text.toLowerCase()) && seen.add(c.text.toLowerCase()));
    if (items.length > MAX_CHECKLIST) return fail(`Keep the checklist to ${MAX_CHECKLIST} items.`, 'checklist');
    const before = new Map((current.checklist ?? []).map((c) => [c.text, c]));
    out.checklist = items.map((c) => {
      const was = before.get(c.text);
      if (was && !!was.done === c.done) return { text: c.text, done: c.done, byName: was.byName ?? '', at: was.at ?? null };
      return { text: c.text, done: c.done, byName: c.done ? byName : '', at: c.done ? now : null };
    });
  }
  return { ok: true, value: out };
};

/** Whole days from [a] to [b] (YYYY-MM-DD). */
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
const plusDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** The milestones after the shoot moved from [oldDay] to [newDay]: those not yet done move by the same days; done ones stay. */
export const shiftMilestones = (milestones, oldDay, newDay) => {
  const n = daysBetween(oldDay, newDay);
  if (!Number.isFinite(n) || n === 0) return milestones;
  return (milestones ?? []).map((m) => (m.doneAt || !m.date ? m : { ...m, date: plusDays(m.date, n) }));
};

// ── storyboard frames: keys and "shot" ticks ──────────────────────────────────

const KEY = /^[A-Za-z0-9_-]{4,40}$/;
export const makeFrameKey = () => `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * The frames an edit sends ([next] — cleaned: text, order, picture, with the key each had) on top of the frames saved ([prev]): a frame
 * that stays (same key) keeps its "shot" tick and who ticked it; a new frame gets a key of its own and no tick. Keys stay unique.
 */
export const mergeStoryboard = (prev, next, { makeKey = makeFrameKey } = {}) => {
  const before = new Map((prev ?? []).filter((f) => f?.key).map((f) => [f.key, f]));
  const used = new Set();
  return (next ?? []).map((f) => {
    const old = f.key && KEY.test(f.key) && !used.has(f.key) ? before.get(f.key) : null;
    let key = old ? f.key : '';
    while (!key || used.has(key)) key = makeKey();
    used.add(key);
    const { key: _sent, shotAt: _a, shotByName: _b, ...rest } = f;
    return { ...rest, key, shotAt: old?.shotAt ?? null, shotByName: old?.shotByName ?? '' };
  });
};

/** Frames saved before frames had keys get one (→ { frames, changed }). */
export const withFrameKeys = (frames, { makeKey = makeFrameKey } = {}) => {
  const used = new Set();
  let changed = false;
  const out = (frames ?? []).map((f) => {
    if (f.key && !used.has(f.key)) {
      used.add(f.key);
      return f;
    }
    changed = true;
    let key = makeKey();
    while (used.has(key)) key = makeKey();
    used.add(key);
    return { ...f, key };
  });
  return { frames: out, changed };
};

/** "6 of 9 shot" — the frames ticked as filmed. */
export const shotProgress = (frames) => {
  const total = (frames ?? []).length;
  const shot = (frames ?? []).filter((f) => f.shotAt).length;
  return { total, shot, pct: total ? Math.round((shot * 100) / total) : 0 };
};

// ── PDFs on the moodboard, the storyboard and the camera movement plan ─────────
// A brief, a lookbook, a drawn storyboard, a shot list, the camera moves (pan, dolly, gimbal…)… uploaded as a PDF and read inside the
// app. Kept by the server (services/shootFiles.js) and only ever sent back through it — the stored file's own address is never handed out.

export const DOC_PARTS = ['moodboard', 'storyboard', 'camera'];
/** Each part as people call it ("The camera movement plan holds up to 20 PDFs"). */
export const DOC_PART_NAMES = { moodboard: 'moodboard', storyboard: 'storyboard', camera: 'camera movement plan' };
export const MAX_PDF_BYTES = 25 * 1024 * 1024;
export const MAX_DOCS_PER_PART = 20;

/**
 * A file name as the upload sent it, read right: browsers send it as UTF-8, but the form reader takes it for Latin-1 — "Flow · Team N"
 * arrives as "Flow Â· Team N", a Malayalam name as gibberish. Read back as UTF-8 when it is valid UTF-8; otherwise kept as it came.
 */
export const utf8Name = (raw) => {
  const s = String(raw ?? '');
  if (!/[\u0080-\u00ff]/.test(s) || /[^\u0000-\u00ff]/.test(s)) return s;
  const back = Buffer.from(s, 'latin1').toString('utf8');
  return back.includes('\uFFFD') ? s : back;
};

/** The file's name as shown: no folders, no control characters, at most 160 characters, ending in .pdf. */
export const pdfName = (raw) => {
  const base = utf8Name(raw).split(/[\\/]/).pop().replace(/[\u0000-\u001f"]/g, '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const name = base || 'document.pdf';
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
};

/** How many pages, read from the file itself — null when the file does not say plainly (compressed object streams). */
export const pdfPageCount = (buffer) => {
  if (!buffer?.length) return null;
  const text = buffer.toString('latin1');
  const n = (text.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
  return n > 0 ? n : null;
};

/** An uploaded file → { ok, name, pages } or { ok: false, message, status }: a real PDF (its first bytes say so), not empty, not too big. */
export const checkPdf = ({ buffer, name } = {}) => {
  if (!buffer?.length) return { ok: false, status: 400, message: 'Choose a PDF to upload.' };
  if (buffer.length > MAX_PDF_BYTES) return { ok: false, status: 413, message: 'A PDF can be at most 25 MB — make it smaller, or share it as a link.' };
  // the file's own first bytes — a renamed photo or Word file is not taken for a PDF
  if (buffer.subarray(0, 1024).indexOf('%PDF-') === -1) return { ok: false, status: 400, message: 'That file is not a PDF. Save it as a PDF and upload it again.' };
  return { ok: true, name: pdfName(name), pages: pdfPageCount(buffer) };
};

export const makeDocKey = () => `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
