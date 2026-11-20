// PLAYING A DROPBOX VIDEO THROUGH OUR OWN SERVER — the rules (pure; tests/mediaProxy.test.js). The Creative Portfolio gallery keeps
// videos as Dropbox share links. Played straight from Dropbox they fail in ways the app cannot fix: Dropbox sometimes sends the wrong file
// type (application/json, application/binary — Firefox and Safari then refuse it), it throttles a link that is opened a lot, and some
// networks / ad blockers block its hosts. So the app asks our server for a short-lived signed address (services/mediaStream.js), and the
// server fetches the file from Dropbox — ONLY from Dropbox's hosts — and hands it on with the right type and byte ranges, keeping a copy
// on disk so the same video is not fetched from Dropbox again and again. When Dropbox refuses, the server says why in plain words.

import crypto from 'node:crypto';

/// Dropbox's own hosts — the only ones the server fetches from (a redirect anywhere else is refused).
export const isAllowedMediaHost = (host) => {
  const h = String(host ?? '').toLowerCase();
  return h === 'dropbox.com' || h.endsWith('.dropbox.com') || h === 'dropboxusercontent.com' || h.endsWith('.dropboxusercontent.com');
};

const VIDEO_TYPES = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg' };
export const PLAYABLE_EXTENSIONS = Object.keys(VIDEO_TYPES);

const extOf = (name) => {
  const n = String(name ?? '');
  return n.includes('.') ? n.split('.').pop().toLowerCase() : '';
};

/**
 * A pasted Dropbox link → the address that returns the file itself (`raw=1`, keeping rlkey / st / … and dropping `dl`).
 * → { url, fileName } or { error } (not https, not Dropbox, a folder, not a video file).
 */
export const dropboxFileUrl = (link) => {
  let u;
  try {
    u = new URL(String(link ?? '').trim());
  } catch {
    return { error: 'That is not a link.' };
  }
  if (u.protocol !== 'https:') return { error: 'Only https Dropbox links can be played.' };
  if (!isAllowedMediaHost(u.hostname)) return { error: 'Only Dropbox links are played through the app.' };
  if (u.username || u.password || (u.port && u.port !== '443')) return { error: 'That is not a Dropbox file link.' };
  const segs = u.pathname.split('/').filter(Boolean);
  if (segs[0] === 'sh' || (segs[0] === 'scl' && segs[1] === 'fo')) return { error: 'That is a Dropbox folder — share the video file itself.' };
  const fileName = segs.length ? decodeURIComponent(segs[segs.length - 1]) : '';
  if (!VIDEO_TYPES[extOf(fileName)]) return { error: 'That Dropbox file is not a video the app can play (mp4, m4v, mov, webm, ogv).' };
  u.hash = '';
  if (u.hostname.endsWith('dropboxusercontent.com')) return { url: u.toString(), fileName };
  u.searchParams.delete('dl');
  u.searchParams.set('raw', '1');
  return { url: u.toString(), fileName };
};

/// The type to send a video with. Dropbox's own is kept when it is a video type the browsers know; otherwise (application/json,
/// application/binary, octet-stream…) it comes from the file's extension. A .mov goes as video/mp4: browsers that refuse
/// "video/quicktime" (Firefox) still play the H.264 inside, and the others play it either way.
export const videoTypeFor = (fileName, upstreamType = '') => {
  const t = String(upstreamType ?? '').split(';')[0].trim().toLowerCase();
  if (['video/mp4', 'video/webm', 'video/ogg'].includes(t)) return t;
  return VIDEO_TYPES[extOf(fileName)] ?? 'video/mp4';
};

// ── the signed address ──────────────────────────────────────────────────────

export const MEDIA_TOKEN_TTL_MS = 12 * 3600 * 1000;
const b64 = (buf) => Buffer.from(buf).toString('base64url');
const keyOf = (secret) => crypto.createHmac('sha256', String(secret)).update('media-stream:v1').digest();
const sigOf = (payload, secret) => b64(crypto.createHmac('sha256', keyOf(secret)).update(payload).digest());

/// A stream token for [url] (the file address — or, with [path], a shared FOLDER link and the file inside it), good for [ttlMs]. It is
/// the only thing the <video> tag sends — never the login token.
export const signMediaToken = (url, { secret, now = Date.now(), ttlMs = MEDIA_TOKEN_TTL_MS, path = '' } = {}) => {
  if (!secret) throw new Error('No secret to sign media links with.');
  const payload = b64(JSON.stringify(path ? { u: url, p: path, e: now + ttlMs } : { u: url, e: now + ttlMs }));
  return `${payload}.${sigOf(payload, secret)}`;
};

/// → { url, expiresAt } (+ path, for a file inside a folder) or { error } (tampered, expired, not a Dropbox address).
export const verifyMediaToken = (token, { secret, now = Date.now() } = {}) => {
  const [payload, sig, extra] = String(token ?? '').split('.');
  if (!payload || !sig || extra !== undefined || !secret) return { error: 'bad' };
  const want = Buffer.from(sigOf(payload, secret));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return { error: 'bad' };
  let body;
  try {
    body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { error: 'bad' };
  }
  if (typeof body?.u !== 'string' || typeof body?.e !== 'number' || (body.p !== undefined && typeof body.p !== 'string')) return { error: 'bad' };
  if (body.e <= now) return { error: 'expired' };
  try {
    if (!isAllowedMediaHost(new URL(body.u).hostname)) return { error: 'bad' };
  } catch {
    return { error: 'bad' };
  }
  return body.p ? { url: body.u, path: body.p, expiresAt: body.e } : { url: body.u, expiresAt: body.e };
};

// ── what Dropbox answered ───────────────────────────────────────────────────

export const MEDIA_PROBLEMS = {
  missing: 'Dropbox says this video is no longer there — it was moved or deleted, or the link was switched off. Paste a new link for it.',
  limit: 'Dropbox has paused this link for now because it was opened too often (Dropbox limits how much a shared link is used each day). It comes back later; until then open it in Dropbox.',
  private: 'Dropbox refused the link — it may need a password, have expired, or be shared only with certain people. Share it as "Anyone with the link can view".',
  page: 'Dropbox sent a web page instead of the video, so it cannot be played here. Open it in Dropbox.',
  dropbox_down: 'Dropbox is not answering properly right now. Try again in a little while.',
  unreachable: 'The server could not reach Dropbox just now.',
  refused: 'Dropbox would not send this video.',
  redirect: 'The link led away from Dropbox, so the app does not follow it.',
  scope: 'The CRM\'s Dropbox app has not been given a permission it needs (IT: Dropbox App Console → Permissions, then run scripts/dropboxConnect.mjs again). Open the folder in Dropbox meanwhile.',
  not_connected: 'Dropbox is not connected on the server (or it refused the server\'s key), so files inside a folder cannot be opened here. Open the folder in Dropbox.',
};

/**
 * Dropbox's answer → null when it is the file, else { code, message, status (what our server answers) }. [body] — the start of the
 * answer when it was a page (Dropbox explains a paused link only in its page).
 */
export const classifyUpstream = ({ status, contentType = '', body = '' }) => {
  const t = String(contentType ?? '').toLowerCase();
  const text = String(body ?? '').toLowerCase();
  const problem = (code, ours) => ({ code, message: MEDIA_PROBLEMS[code], status: ours });
  if (status === 429 || /too many requests|too much traffic|temporarily disabled|banned|bandwidth/.test(text)) return problem('limit', 429);
  if (status === 404 || status === 410) return problem('missing', 404);
  if (status === 401 || status === 403) return problem('private', 403);
  if (status >= 500) return problem('dropbox_down', 502);
  if (status === 416) return null; // a range past the end — the player's own business
  if (status < 200 || status >= 300) return problem('refused', 502);
  if (t.startsWith('text/html')) return problem(/password|expired|not have access|sign in/.test(text) ? 'private' : 'page', 502);
  return null;
};
