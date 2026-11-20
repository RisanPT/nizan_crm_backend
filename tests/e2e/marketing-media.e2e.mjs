// End-to-end check of playing gallery videos through our server (/api/marketing/media): the Marketing team gets a signed link; the
// stream needs no login, sends Dropbox's file with the right type and byte ranges, follows Dropbox's redirects but never off Dropbox,
// says in plain words why Dropbox refused, keeps a copy on disk (the next plays never reach Dropbox) within its size, and refuses a
// forged or expired link. DROPBOX IS FAKED — no request leaves this machine.
// Against a THROWAWAY local MongoDB (127.0.0.1:27099; refuses anything else, drops its database first):
//   node tests/e2e/marketing-media.e2e.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readdirSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
for (const k of ['NODEMAILER_EMAIL', 'NODEMAILER_PASS', 'SMTP_HOST', 'MSG91_AUTHKEY', 'SMS_PROVIDER', 'TEAMN_CHAT_KEY', 'ORS_API_KEY', 'GEMINI_API_KEY', 'CLOUDFLARE_API_TOKEN', 'HF_TOKEN', 'POLLEN_KEY', 'REVIEW_AUTO_SEND_FROM', 'TIMEBOX_API_KEY', 'TIMEBOX_API_URL', 'CLOUDINARY_URL', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'MEDIA_STREAM_SECRET']) {
  process.env[k] = '';
}
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-e2e-'));
process.env.MEDIA_CACHE_DIR = cacheDir;
process.env.MEDIA_CACHE_MAX_MB = String(10_500 / (1024 * 1024)); // room for two 5000-byte files, not three

await mongoose.connect('mongodb://127.0.0.1:27099/marketing_media_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
await mongoose.connection.dropDatabase();

const root = new URL('../../', import.meta.url);
for (const f of readdirSync(new URL('models/', root))) await import(new URL(`models/${f}`, root));
const imp = (p) => import(new URL(p, root)).then((m) => m.default ?? m);
const User = await imp('models/User.js');
const Role = await imp('models/Role.js');
const { _setMediaFetch, _resetMediaProbes } = await import(new URL('services/mediaStream.js', root));
const { signMediaToken, dropboxFileUrl } = await import(new URL('utils/mediaProxy.js', root));
const { sanitizeErrorResponses, errorHandler } = await import(new URL('middleware/errorMiddleware.js', root));

// ── a fake Dropbox ──────────────────────────────────────────────────────────
const fileOf = (name, size = 5000) => Buffer.from(Array.from({ length: size }, (_, i) => (i * 7 + name.length) % 251));
const FILES = { 'good-1': fileOf('good-1'), 'good-2': fileOf('good-2'), 'good-3': fileOf('good-3'), big: fileOf('big', 6000), unsized: fileOf('unsized', 6000) };
const calls = [];
const bigPulls = []; // per answer for 'big': how many pieces were read
_setMediaFetch(async (url, opts) => {
  const u = new URL(url);
  calls.push({ host: u.hostname, path: u.pathname, range: opts.headers.range ?? null });
  if (u.hostname === 'www.dropbox.com') {
    const name = u.pathname.split('/')[2];
    if (u.searchParams.get('raw') !== '1') return new Response('<html>preview page</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    if (FILES[name]) return new Response(null, { status: 302, headers: { location: `https://uc1.dl.dropboxusercontent.com/cd/0/inline/${name}` } });
    if (name === 'away') return new Response(null, { status: 302, headers: { location: 'https://evil.example.com/x.mp4' } });
    if (name === 'paused') return new Response('<html><body>This link is temporarily disabled</body></html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (name === 'gone') return new Response('<html>Not found</html>', { status: 404, headers: { 'content-type': 'text/html' } });
    if (name === 'preview') return new Response('<html><title>Dropbox - clip.mp4</title></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  }
  if (u.hostname === 'uc1.dl.dropboxusercontent.com') {
    const file = FILES[u.pathname.split('/').pop()];
    // Dropbox's own wrong type, as browsers have seen it
    const range = opts.headers.range;
    if (range) {
      const [, a, b] = /bytes=(\d+)-(\d*)/.exec(range);
      const s = Number(a);
      const e = b ? Math.min(Number(b), file.length - 1) : file.length - 1;
      return new Response(file.subarray(s, e + 1), { status: 206, headers: { 'content-type': 'application/json', 'content-range': `bytes ${s}-${e}/${file.length}`, 'content-length': String(e - s + 1) } });
    }
    // 'big' says its size and is sent in small pieces, counted — a copy that would not fit must not fetch it all
    if (u.pathname.endsWith('/big') && !range) {
      const pulls = { n: 0 };
      bigPulls.push(pulls);
      let at = 0;
      const stream = new ReadableStream({
        pull(c) {
          if (at >= file.length) return c.close();
          pulls.n += 1;
          c.enqueue(file.subarray(at, at + 100));
          at += 100;
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(file.length) } });
    }
    // 'unsized' comes without its size (sent in pieces), so only the bytes counted can stop the copy
    if (u.pathname.endsWith('/unsized')) return new Response(new Blob([file]).stream(), { status: 200, headers: { 'content-type': 'video/mp4' } });
    return new Response(file, { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(file.length) } });
  }
  throw new Error(`the test network has no ${url}`);
});

const app = express();
app.use(express.json());
app.use(sanitizeErrorResponses);
app.use('/api/marketing/media', await imp('routes/marketingMediaRoutes.js'));
app.use('/api/marketing', await imp('routes/marketingRoutes.js')); // as in server.js: after — its login check must not catch the stream
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/api`;
const get = async (p, { token, headers = {}, method = 'GET' } = {}) => {
  const res = await fetch(`${base}${p}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
  const buf = Buffer.from(await res.arrayBuffer());
  let body = null;
  try {
    body = JSON.parse(buf.toString('utf8'));
  } catch {
    /* the file */
  }
  return { status: res.status, headers: res.headers, buf, body };
};

let pass = 0;
const failures = [];
const check = async (name, fn) => {
  try {
    await fn();
    pass += 1;
    console.log(`  ✔ ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  ✖ ${name}\n      ${String(e.stack ?? e.message).split('\n').slice(0, 8).join('\n      ')}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const share = (name, file = 'clip.mp4') => `https://www.dropbox.com/s/${name}/${file}?dl=0`;
const keyOf = (name) => crypto.createHash('sha256').update(dropboxFileUrl(share(name)).url).digest('hex').slice(0, 40);
const cached = (name) => fs.existsSync(path.join(cacheDir, `${keyOf(name)}.json`));
const waitCached = async (name) => {
  for (let i = 0; i < 100 && !cached(name); i += 1) await sleep(20);
  return cached(name);
};

let n = 0;
const login = async (name, role) => {
  n += 1;
  const user = await User.create({ name, email: `${name}${n}@e2e.test`, password: 'secret123', role });
  return jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET);
};
await Role.updateOne({ key: 'marketing_staff' }, { $setOnInsert: { key: 'marketing_staff', label: 'Marketing staff', permissions: ['marketing'] } }, { upsert: true });
const member = await login('Saeeda', 'marketing_staff');
const sales = await login('Sam', 'sales');
const linkFor = async (name, extra = '') => (await get(`/marketing/media/link?url=${encodeURIComponent(share(name))}${extra}`, { token: member })).body;

console.log('The signed link');
await check('the Marketing team gets a stream link; others, folders and other sites are refused', async () => {
  const r = await get(`/marketing/media/link?url=${encodeURIComponent(share('good-1'))}`, { token: member });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.match(r.body.path, /^\/marketing\/media\/stream\/[\w-]+\.[\w-]+$/);
  assert.equal(r.body.fileName, 'clip.mp4');
  assert.equal(calls.length, 0, 'no probe asked for: Dropbox is not called');
  assert.equal((await get(`/marketing/media/link?url=${encodeURIComponent(share('good-1'))}`, { token: sales })).status, 403);
  assert.equal((await get(`/marketing/media/link?url=${encodeURIComponent(share('good-1'))}`)).status, 401);
  const folder = await get(`/marketing/media/link?url=${encodeURIComponent('https://www.dropbox.com/scl/fo/abc/reels?rlkey=k')}`, { token: member });
  assert.deepEqual([folder.status, folder.body.code], [400, 'not_playable']);
  assert.equal((await get(`/marketing/media/link?url=${encodeURIComponent('https://evil.example.com/x.mp4')}`, { token: member })).status, 400);
});
await check('with a probe, Dropbox\'s refusal comes back in plain words — and a redirect off Dropbox is never followed', async () => {
  const good = await linkFor('good-1', '&probe=1');
  assert.deepEqual([good.ok, good.size, good.type], [true, 5000, 'video/mp4']);
  assert.deepEqual(calls.at(-1), { host: 'uc1.dl.dropboxusercontent.com', path: '/cd/0/inline/good-1', range: 'bytes=0-1023' });
  const paused = await linkFor('paused', '&probe=1');
  assert.deepEqual([paused.ok, paused.code, paused.retryDirect], [false, 'limit', false]);
  assert.match(paused.message, /opened too often/);
  assert.equal((await linkFor('gone', '&probe=1')).code, 'missing');
  const away = await linkFor('away', '&probe=1');
  assert.deepEqual([away.ok, away.code], [false, 'redirect']);
  assert.ok(!calls.some((c) => c.host === 'evil.example.com'), 'never fetched');
  // remembered for a while: asking again does not ask Dropbox again
  const before = calls.length;
  await linkFor('good-1', '&probe=1');
  assert.equal(calls.length, before);
  _resetMediaProbes();
});

console.log('The stream');
let tokenGood1;
await check('no login needed; Dropbox\'s file with the right type (not the application/json Dropbox sent) and the bytes asked for', async () => {
  tokenGood1 = (await linkFor('good-1')).token;
  const before = calls.length;
  const r = await get(`/marketing/media/stream/${tokenGood1}`, { headers: { range: 'bytes=100-199' } });
  assert.equal(r.status, 206, r.buf.toString().slice(0, 200));
  assert.equal(r.headers.get('content-type'), 'video/mp4');
  assert.equal(r.headers.get('content-range'), 'bytes 100-199/5000');
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  assert.ok(r.buf.equals(FILES['good-1'].subarray(100, 200)));
  // the share link, then Dropbox's redirect — the range passed on both times (a copy for next time may follow)
  assert.deepEqual(calls.slice(before, before + 2), [
    { host: 'www.dropbox.com', path: '/s/good-1/clip.mp4', range: 'bytes=100-199' },
    { host: 'uc1.dl.dropboxusercontent.com', path: '/cd/0/inline/good-1', range: 'bytes=100-199' },
  ]);
});
await check('a copy is kept: the next plays come from disk — ranges and all — and never reach Dropbox', async () => {
  assert.equal(await waitCached('good-1'), true, 'copied after the first play');
  const before = calls.length;
  const tail = await get(`/marketing/media/stream/${tokenGood1}`, { headers: { range: 'bytes=4990-' } });
  assert.equal(tail.status, 206);
  assert.equal(tail.headers.get('content-type'), 'video/mp4');
  assert.equal(tail.headers.get('content-range'), 'bytes 4990-4999/5000');
  assert.ok(tail.buf.equals(FILES['good-1'].subarray(4990)));
  const whole = await get(`/marketing/media/stream/${tokenGood1}`);
  assert.deepEqual([whole.status, whole.buf.length], [200, 5000]);
  assert.ok(whole.buf.equals(FILES['good-1']));
  const head = await get(`/marketing/media/stream/${tokenGood1}`, { method: 'HEAD' });
  assert.deepEqual([head.status, head.headers.get('content-length')], [200, '5000']);
  assert.equal(calls.length, before, 'Dropbox was not asked');
});
await check('a refused link answers why; a forged, expired or made-up link is refused', async () => {
  const paused = await get(`/marketing/media/stream/${(await linkFor('paused')).token}`);
  assert.deepEqual([paused.status, paused.body.code], [429, 'limit']);
  const gone = await get(`/marketing/media/stream/${(await linkFor('gone')).token}`);
  assert.deepEqual([gone.status, gone.body.code], [404, 'missing']);
  const page = await get(`/marketing/media/stream/${(await linkFor('preview')).token}`);
  assert.deepEqual([page.status, page.body.code], [502, 'page'], 'Dropbox\'s page is not passed on as the video');
  const expired = signMediaToken(dropboxFileUrl(share('good-1')).url, { secret: process.env.JWT_SECRET, ttlMs: -1 });
  assert.deepEqual([(await get(`/marketing/media/stream/${expired}`)).status, (await get(`/marketing/media/stream/${expired}`)).body.code], [403, 'expired']);
  const forged = signMediaToken(dropboxFileUrl(share('good-1')).url, { secret: 'not-ours' });
  assert.equal((await get(`/marketing/media/stream/${forged}`)).body.code, 'bad_link');
  assert.equal((await get('/marketing/media/stream/abc.def')).status, 403);
  // a HEAD to a link Dropbox answers: the size, no body fetched
  const head = await get(`/marketing/media/stream/${(await linkFor('good-2')).token}`, { method: 'HEAD' });
  assert.deepEqual([head.status, head.headers.get('content-length'), head.headers.get('content-type')], [200, '5000', 'video/mp4']);
  assert.equal(calls.at(-1).range, 'bytes=0-0');
});
await check('the copies keep to their size — the least recently played goes first; a file too big is played, not kept', async () => {
  const play = async (name) => {
    const r = await get(`/marketing/media/stream/${(await linkFor(name)).token}`);
    assert.equal(r.status, 200, name);
    assert.ok(r.buf.equals(FILES[name]), name);
  };
  await play('good-2');
  assert.equal(await waitCached('good-2'), true);
  await sleep(30);
  await play('good-1'); // from disk: now the most recently played
  await sleep(30);
  await play('good-3');
  assert.equal(await waitCached('good-3'), true);
  for (let i = 0; i < 50 && cached('good-2'); i += 1) await sleep(20);
  assert.deepEqual([cached('good-1'), cached('good-2'), cached('good-3')], [true, false, true]);
  assert.ok(!fs.existsSync(path.join(cacheDir, `${keyOf('good-2')}.bin`)), 'its file goes too');
  await play('big');
  await play('unsized');
  await sleep(200);
  assert.equal(cached('big'), false, 'more than one file\'s share of the cache');
  assert.equal(bigPulls.length, 2, 'played once, and once for the copy');
  assert.equal(bigPulls[0].n, 60, 'the play gets all of it');
  assert.ok(bigPulls[1].n <= 2, `the copy stops at the size Dropbox gave, before fetching it (${bigPulls[1].n} pieces read)`);
  assert.equal(cached('unsized'), false, 'its size was not given: stopped once counted');
  assert.deepEqual(fs.readdirSync(cacheDir).filter((f) => f.endsWith('.part')), [], 'nothing half-written left behind');
});

server.close();
await mongoose.disconnect();
fs.rmSync(cacheDir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
