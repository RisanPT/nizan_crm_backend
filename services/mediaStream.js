import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { classifyUpstream, isAllowedMediaHost, MEDIA_PROBLEMS, videoTypeFor } from '../utils/mediaProxy.js';
import { folderProblemOf, pictureTypeOf } from '../utils/dropboxFolder.js';
import { fetchSharedLinkFile, missingScopeOf } from './dropbox.js';

// PLAYING A DROPBOX VIDEO THROUGH OUR SERVER (the rules: utils/mediaProxy.js). Fetches the file from Dropbox — following its redirects
// only while they stay on Dropbox's hosts — and hands it on with byte ranges (a video player asks for pieces), the right type, and a
// plain reason when Dropbox refuses. A copy is kept on disk (MEDIA_CACHE_DIR, at most MEDIA_CACHE_MAX_MB, default 1024; 0 = none),
// the least recently played going first, so a video the team keeps opening is fetched from Dropbox once — Dropbox pauses a shared link
// that is used too much.
//
// A SOURCE is a Dropbox file address (a string), or { url, path }: a file inside a shared FOLDER link (an artist's footage folder), fetched
// through the Dropbox app (services/dropbox.js) — the folder link alone has no address for each file.

const MAX_REDIRECTS = 5;
const HEADERS_TIMEOUT_MS = 20_000;
const PROBE_TTL_MS = 10 * 60 * 1000;
const MAX_FILLS = 2; // copies being made at once

// tests replace the network
let fetchImpl = (...a) => fetch(...a);
export const _setMediaFetch = (fn) => {
  fetchImpl = fn ?? ((...a) => fetch(...a));
};

const cacheDir = () => process.env.MEDIA_CACHE_DIR || path.join(os.tmpdir(), 'nizan-media-cache');
const cacheCap = () => {
  const mb = Number.parseFloat(process.env.MEDIA_CACHE_MAX_MB ?? '1024');
  return Number.isFinite(mb) && mb > 0 ? Math.floor(mb * 1024 * 1024) : 0;
};
/// One file may take at most half the cache, and never more than 400 MB.
const fileCap = () => Math.min(400 * 1024 * 1024, Math.floor(cacheCap() / 2));
const srcKey = (src) => (typeof src === 'string' ? src : `${src.url}#${src.path}`);
const keyOf = (src) => crypto.createHash('sha256').update(srcKey(src)).digest('hex').slice(0, 40);
/** The type a file is sent with: a picture's own, else a video type (utils/mediaProxy.js videoTypeFor). */
const typeFor = (fileName, upstream) => pictureTypeOf(fileName) ?? videoTypeFor(fileName, upstream);
const filesOf = (key) => ({ data: path.join(cacheDir(), `${key}.bin`), meta: path.join(cacheDir(), `${key}.json`) });

/**
 * GET [url] from Dropbox, following redirects only on Dropbox's hosts. [range] is passed on. → { res } (the final answer) or
 * { problem } (a redirect off Dropbox, or Dropbox could not be reached).
 */
export const fetchFromDropbox = async (url, { range = null, signal = null } = {}) => {
  let at = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const u = new URL(at);
    if (u.protocol !== 'https:' || !isAllowedMediaHost(u.hostname)) return { problem: { code: 'redirect', message: MEDIA_PROBLEMS.redirect, status: 502 } };
    // Dropbox gets HEADERS_TIMEOUT_MS to answer; the file itself then takes as long as it takes (the player, or [signal], stops it)
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), HEADERS_TIMEOUT_MS);
    const stop = () => ac.abort();
    if (signal?.aborted) ac.abort();
    signal?.addEventListener('abort', stop, { once: true });
    let res;
    try {
      res = await fetchImpl(u.toString(), {
        method: 'GET',
        redirect: 'manual',
        headers: { ...(range ? { range } : {}), 'user-agent': 'TeamN-CRM-media/1.0', accept: '*/*' },
        signal: ac.signal,
      });
    } catch {
      signal?.removeEventListener('abort', stop);
      return { problem: { code: 'unreachable', message: MEDIA_PROBLEMS.unreachable, status: 502 } };
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel().catch(() => {});
      at = new URL(res.headers.get('location'), u).toString();
      continue;
    }
    return { res };
  }
  return { problem: { code: 'refused', message: MEDIA_PROBLEMS.refused, status: 502 } };
};

const asProblem = (code) => ({ code, message: MEDIA_PROBLEMS[code] ?? MEDIA_PROBLEMS.refused, status: code === 'missing' ? 404 : code === 'private' ? 403 : code === 'limit' ? 429 : 502 });

/** GET a source (see the top): a file address from Dropbox's hosts, or a file inside a shared folder through the Dropbox app. */
export const fetchSource = async (src, opts = {}) => {
  if (typeof src === 'string') return fetchFromDropbox(src, opts);
  const { res, problem } = await fetchSharedLinkFile(src.url, src.path, opts);
  if (problem) return { problem: asProblem(problem.code) };
  // the app's own answers about the link (409: no such file, not shared with anyone, …) and its key (401) — read here, not as a file
  if (res.status === 409 || res.status === 400 || res.status === 401) {
    const text = await res.text().catch(() => '');
    let json = {};
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON — the text is the reason
    }
    if (res.status === 401) return { problem: asProblem(missingScopeOf(json) ? 'scope' : 'not_connected') };
    const summary = json.error_summary ?? text;
    const f = folderProblemOf(summary);
    return { problem: asProblem(f.code === 'private' || f.code === 'password' || f.code === 'expired' ? 'private' : f.code === 'missing' ? 'missing' : 'refused') };
  }
  return { res };
};

/// What Dropbox's answer [res] means (reads the start of a page to find out why it is not the file). → null or the problem.
const problemOf = async (res) => {
  const type = res.headers.get('content-type') ?? '';
  let body = '';
  if (type.toLowerCase().startsWith('text/html') || res.status >= 400) {
    body = (await res.text().catch(() => '')).slice(0, 64 * 1024);
  }
  return classifyUpstream({ status: res.status, contentType: type, body });
};

// ── is it playable? (a small range, remembered for a while) ─────────────────

const probes = new Map(); // url → { at, result }

/// Asks Dropbox for the first bytes of [src] (a source — see the top). → { ok: true, size, type } or { ok: false, code, message, retryDirect }.
export const probeDropbox = async (src, fileName, now = Date.now()) => {
  const pk = srcKey(src);
  const hit = probes.get(pk);
  if (hit && now - hit.at < PROBE_TTL_MS) return hit.result;
  if (fs.existsSync(filesOf(keyOf(src)).meta)) return { ok: true, cached: true };
  const { res, problem } = await fetchSource(src, { range: 'bytes=0-1023' });
  let result;
  if (problem) result = { ok: false, code: problem.code, message: problem.message, retryDirect: problem.code === 'unreachable' };
  else {
    const p = await problemOf(res);
    if (p) result = { ok: false, code: p.code, message: p.message, retryDirect: false };
    else {
      await res.body?.cancel().catch(() => {});
      const total = Number((res.headers.get('content-range') ?? '').split('/')[1]) || Number(res.headers.get('content-length')) || null;
      result = { ok: true, size: total, type: typeFor(fileName, res.headers.get('content-type')) };
    }
  }
  // a refusal is remembered only briefly (a paused link comes back), a good answer for the whole while
  probes.set(pk, { at: result.ok ? now : now - PROBE_TTL_MS + 60_000, result });
  if (probes.size > 500) probes.delete(probes.keys().next().value);
  return result;
};
export const _resetMediaProbes = () => probes.clear();

// ── the copy on disk ────────────────────────────────────────────────────────

const filling = new Map(); // key → promise

const readMeta = async (key) => {
  try {
    return JSON.parse(await fsp.readFile(filesOf(key).meta, 'utf8'));
  } catch {
    return null;
  }
};

/// Drops the least recently played copies until the cache fits.
export const evictMediaCache = async () => {
  const cap = cacheCap();
  let entries;
  try {
    entries = (await fsp.readdir(cacheDir())).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }
  const files = [];
  for (const f of entries) {
    const key = f.slice(0, -5);
    const { data, meta } = filesOf(key);
    try {
      const [d, m] = await Promise.all([fsp.stat(data), fsp.stat(meta)]);
      files.push({ key, size: d.size, used: m.mtimeMs });
    } catch {
      await Promise.all([fsp.rm(data, { force: true }), fsp.rm(meta, { force: true })]);
    }
  }
  files.sort((a, b) => a.used - b.used);
  let total = files.reduce((a, f) => a + f.size, 0);
  for (const f of files) {
    if (total <= cap) break;
    const { data, meta } = filesOf(f.key);
    await Promise.all([fsp.rm(meta, { force: true }), fsp.rm(data, { force: true })]);
    total -= f.size;
  }
};

/// Fetches the whole of [src] (a source) into the cache (once at a time per file, a few files at once; too big a file is not kept).
export const fillMediaCache = (src, fileName) => {
  if (!cacheCap()) return null;
  const key = keyOf(src);
  if (filling.has(key)) return filling.get(key);
  if (filling.size >= MAX_FILLS) return null;
  const job = (async () => {
    const { data, meta } = filesOf(key);
    const part = `${data}.${process.pid}.part`;
    try {
      if (await readMeta(key)) return;
      await fsp.mkdir(cacheDir(), { recursive: true });
      const { res, problem } = await fetchSource(src);
      // only the file itself is kept (not a refusal, not a page) — read from the headers, the body is the file
      if (problem || !res.ok || String(res.headers.get('content-type') ?? '').toLowerCase().startsWith('text/html')) {
        await res?.body?.cancel().catch(() => {});
        return;
      }
      const max = fileCap();
      const declared = Number(res.headers.get('content-length')) || 0;
      if (declared > max) {
        await res.body?.cancel().catch(() => {});
        return;
      }
      let seen = 0;
      const limit = new Transform({
        transform(chunk, _enc, cb) {
          seen += chunk.length;
          cb(seen > max ? new Error('too big to keep') : null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body), limit, fs.createWriteStream(part));
      await fsp.rename(part, data);
      await fsp.writeFile(meta, JSON.stringify({ type: typeFor(fileName, res.headers.get('content-type')), size: seen, at: new Date().toISOString() }));
      await evictMediaCache();
    } catch {
      await fsp.rm(part, { force: true });
    } finally {
      filling.delete(key);
    }
  })();
  filling.set(key, job);
  return job;
};

// ── the stream ──────────────────────────────────────────────────────────────

const COMMON = { 'Cache-Control': 'private, max-age=3600', 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff' };

/**
 * Sends [src] (a source — see the top) to the player: from the copy on disk when there is one (with ranges), else straight from Dropbox
 * (the range asked for passed on) while a copy is made for next time.
 */
export const streamDropboxFile = async (req, res, src, fileName) => {
  const key = keyOf(src);
  const meta = await readMeta(key);
  if (meta) {
    const { data, meta: metaFile } = filesOf(key);
    const now = new Date();
    await fsp.utimes(metaFile, now, now).catch(() => {}); // played: kept longer
    res.set({ ...COMMON, 'Content-Type': meta.type });
    return res.sendFile(data, { dotfiles: 'allow', lastModified: false, etag: false }, (err) => {
      if (err && !res.headersSent) res.status(err.status === 416 ? 416 : 500).end();
    });
  }

  const ac = new AbortController();
  req.on('close', () => ac.abort());
  const head = req.method === 'HEAD';
  const { res: up, problem } = await fetchSource(src, { range: head ? 'bytes=0-0' : (req.headers.range ?? null), signal: ac.signal });
  if (problem) return res.status(problem.status).json({ code: problem.code, message: problem.message });
  const p = await problemOf(up);
  if (p) return res.status(p.status).json({ code: p.code, message: p.message });

  const type = typeFor(fileName, up.headers.get('content-type'));
  res.set({ ...COMMON, 'Content-Type': type });
  if (head) {
    await up.body?.cancel().catch(() => {});
    const total = Number((up.headers.get('content-range') ?? '').split('/')[1]) || Number(up.headers.get('content-length')) || 0;
    if (total) res.set('Content-Length', String(total));
    return res.status(200).end();
  }
  for (const h of ['content-length', 'content-range']) if (up.headers.get(h)) res.set(h, up.headers.get(h));
  res.status(up.status);
  fillMediaCache(src, fileName); // next time from disk
  if (!up.body) return res.end();
  try {
    await pipeline(Readable.fromWeb(up.body), res);
  } catch {
    // the player stopped listening (seeking, closing) — nothing to do
  }
};
