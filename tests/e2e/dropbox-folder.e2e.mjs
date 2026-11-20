// End-to-end check of FOLDER links — what artists actually send for a work's footage ("Share → Copy link" on a Dropbox folder):
//   • with no Dropbox app on the server, the gallery still knows it is a folder: how to open it, and all of it as one .zip;
//   • with the app, the folder is read through its link — any account's folder shared "anyone with the link" — its videos and pictures
//     listed (sub-folders too), each played through our relay in pieces (byte ranges) with the right type, a copy kept on disk;
//   • a link Dropbox will not open for anyone is refused when the artist hands it in, with how to share it; Dropbox's own trouble never
//     holds the artist up.
// DROPBOX IS FAKED — no request leaves this machine. Against a THROWAWAY local MongoDB (127.0.0.1:27099; refuses anything else, drops
// its database first):   node tests/e2e/dropbox-folder.e2e.mjs
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
// NOTHING leaves this machine: every outbound key is blanked (the code loads the real .env, which never overrides a set variable)
for (const k of ['NODEMAILER_EMAIL', 'NODEMAILER_PASS', 'SMTP_HOST', 'MSG91_AUTHKEY', 'SMS_PROVIDER', 'TEAMN_CHAT_KEY', 'ORS_API_KEY', 'GEMINI_API_KEY', 'CLOUDFLARE_API_TOKEN', 'HF_TOKEN', 'POLLEN_KEY', 'REVIEW_AUTO_SEND_FROM', 'TIMEBOX_API_KEY', 'TIMEBOX_API_URL', 'CLOUDINARY_URL', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'META_APP_SECRET', 'META_SYSTEM_TOKEN', 'MEDIA_STREAM_SECRET', 'DROPBOX_ACCESS_TOKEN', 'DROPBOX_APP_KEY', 'DROPBOX_APP_SECRET', 'DROPBOX_REFRESH_TOKEN', 'DROPBOX_API_URL', 'DROPBOX_CONTENT_URL', 'DROPBOX_TOKEN_URL', 'DROPBOX_ROOT']) {
  process.env[k] = '';
}
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-e2e-'));
process.env.MEDIA_CACHE_DIR = cacheDir;
process.env.MEDIA_CACHE_MAX_MB = '5';

await mongoose.connect('mongodb://127.0.0.1:27099/dropbox_folder_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
await mongoose.connection.dropDatabase();

const root = new URL('../../', import.meta.url);
for (const f of readdirSync(new URL('models/', root))) await import(new URL(`models/${f}`, root));
const imp = (p) => import(new URL(p, root)).then((m) => m.default ?? m);
const User = await imp('models/User.js');
const Role = await imp('models/Role.js');
const Employee = await imp('models/Employee.js');
const Booking = await imp('models/Booking.js');
const Asset = await imp('models/MarketingAsset.js');
const WorkFootage = await imp('models/WorkFootage.js');
const { _setDropboxFetch } = await import(new URL('services/dropbox.js', root));
const { _resetFolderListings } = await import(new URL('services/sharedFolder.js', root));
const { _resetMediaProbes } = await import(new URL('services/mediaStream.js', root));
const { sanitizeErrorResponses, errorHandler } = await import(new URL('middleware/errorMiddleware.js', root));
const { ensureDefaultRoles } = await import(new URL('controllers/roleController.js', root));
const { istDayKey, addDays } = await import(new URL('utils/istDate.js', root));
await import(new URL('utils/asyncErrors.js', root));
await ensureDefaultRoles();
await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));

// ── a fake Dropbox (the API and its content host) ───────────────────────────
const bytesOf = (name, size) => Buffer.from(Array.from({ length: size }, (_, i) => (i * 13 + name.length) % 251));
const GOOD = 'https://www.dropbox.com/scl/fo/good1/KEY1?rlkey=r1&st=s1&dl=0';
const GOOD_CLEAN = 'https://www.dropbox.com/scl/fo/good1/KEY1?rlkey=r1&st=s1';
const PRIVATE = 'https://www.dropbox.com/scl/fo/locked/KEY2?rlkey=r2&dl=0';
const TREE = {
  '': [
    { '.tag': 'file', name: 'C0010.MP4', size: 3000 },
    { '.tag': 'folder', name: 'Stills' },
    { '.tag': 'file', name: 'C0002.MP4', size: 2000 },
    { '.tag': 'file', name: 'Reveal · ദിയ.mov', size: 1500 },
    { '.tag': 'file', name: 'notes.txt', size: 10 },
  ],
  '/Stills': [{ '.tag': 'file', name: 'IMG_1.jpg', size: 800 }],
};
const FILES = { '/C0002.MP4': bytesOf('C0002', 2000), '/C0010.MP4': bytesOf('C0010', 3000), '/Reveal · ദിയ.mov': bytesOf('Reveal', 1500), '/Stills/IMG_1.jpg': bytesOf('IMG', 800) };
const dbx = { on: true, down: false, noScope: false, lists: [], contents: [] };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
_setDropboxFetch(async (url, opts) => {
  const u = new URL(url);
  if (dbx.down) throw new Error('offline');
  if (opts.headers?.authorization !== 'Bearer test-token') return json(401, { error_summary: 'invalid_access_token/' });
  // an app that was never given its permissions: Dropbox answers 401 "missing_scope" (seen on the real Dropbox, 2026-11-19)
  if (dbx.noScope) return json(401, { error_summary: 'missing_scope/', error: { '.tag': 'missing_scope', required_scope: u.hostname.startsWith('content') ? 'sharing.read' : 'files.metadata.read' } });
  if (u.hostname === 'api.dropboxapi.com' && u.pathname === '/2/files/list_folder') {
    const b = JSON.parse(opts.body);
    dbx.lists.push(b);
    if (b.recursive !== undefined) return json(400, { error_summary: 'recursive is not supported for shared links' });
    if (b.shared_link?.url !== GOOD_CLEAN) return json(409, { error_summary: 'shared_link_access_denied/..', error: { '.tag': 'shared_link_access_denied' } });
    const entries = TREE[b.path];
    if (!entries) return json(409, { error_summary: 'path/not_found/..' });
    // the top comes in two pages, as Dropbox does with a big folder
    if (b.path === '') return json(200, { entries: entries.slice(0, 2), has_more: true, cursor: 'page2' });
    return json(200, { entries, has_more: false, cursor: 'x' });
  }
  if (u.hostname === 'api.dropboxapi.com' && u.pathname === '/2/files/list_folder/continue') {
    const b = JSON.parse(opts.body);
    dbx.lists.push(b);
    return json(200, { entries: TREE[''].slice(2), has_more: false, cursor: 'end' });
  }
  if (u.hostname === 'content.dropboxapi.com' && u.pathname === '/2/sharing/get_shared_link_file') {
    const arg = JSON.parse(opts.headers['dropbox-api-arg']);
    dbx.contents.push({ arg, range: opts.headers.range ?? null, rawArg: opts.headers['dropbox-api-arg'] });
    if (arg.url !== GOOD_CLEAN) return json(409, { error_summary: 'shared_link_access_denied/..' });
    const file = FILES[arg.path];
    if (!file) return json(409, { error_summary: 'path/not_found/..' });
    const range = opts.headers.range;
    // Dropbox sends files as application/octet-stream — the relay must give the player the real type
    if (range) {
      const [, a, b] = /bytes=(\d+)-(\d*)/.exec(range);
      const s = Number(a);
      const e = b ? Math.min(Number(b), file.length - 1) : file.length - 1;
      return new Response(file.subarray(s, e + 1), { status: 206, headers: { 'content-type': 'application/octet-stream', 'content-range': `bytes ${s}-${e}/${file.length}`, 'content-length': String(e - s + 1) } });
    }
    return new Response(file, { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(file.length) } });
  }
  if (u.hostname === 'api.dropbox.com' && u.pathname === '/oauth2/token') return json(400, { error: 'invalid_grant' });
  throw new Error(`the test network has no ${url}`);
});
const connect = (on) => {
  process.env.DROPBOX_ACCESS_TOKEN = on ? 'test-token' : '';
  _resetFolderListings();
  _resetMediaProbes();
};
const app = express();
app.use(express.json());
app.use(sanitizeErrorResponses);
app.use('/api/marketing/media', await imp('routes/marketingMediaRoutes.js'));
app.use('/api/work-footage', await imp('routes/workFootageRoutes.js'));
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/api`;
const call = async (method, p, { token, headers = {}, body } = {}) => {
  const res = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const buf = Buffer.from(await res.arrayBuffer());
  let b = null;
  try {
    b = JSON.parse(buf.toString('utf8'));
  } catch {
    /* the file */
  }
  return { status: res.status, headers: res.headers, buf, body: b };
};
const q = (o) => new URLSearchParams(o).toString();

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

let n = 0;
const login = async (name, role, dept = 'Marketing') => {
  n += 1;
  const emp = await Employee.create({ name, department: dept, status: 'active', artistRole: 'artist', phone: `91000000${String(n).padStart(2, '0')}` });
  const user = await User.create({ name, email: `f${n}@e2e.test`, password: 'secret123', role, employeeId: emp._id });
  return { emp, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
};
await Role.updateOne({ key: 'marketing_staff' }, { $setOnInsert: { key: 'marketing_staff', label: 'Marketing staff', permissions: ['marketing'] } }, { upsert: true });
const mkt = await login('Shahala', 'marketing_staff');
const ansha = await login('Ansha', 'artist', 'Operations');
const sales = await login('Sam', 'sales', 'Sales');

console.log('\n— no Dropbox app on the server —');
connect(false);
await check('the folder is still a folder: how to open it, and all of it as one .zip; nothing is asked of Dropbox', async () => {
  const r = await call('GET', `/marketing/media/folder?${q({ url: GOOD })}`, { token: mkt.token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.connected, r.body.ok, r.body.code], [false, false, 'not_connected']);
  assert.equal(r.body.zipUrl, `${GOOD_CLEAN}&dl=1`);
  assert.match(r.body.message, /Open the folder in Dropbox/);
  assert.equal(dbx.lists.length, 0);
  const l = await call('GET', `/marketing/media/link?${q({ url: GOOD, path: '/C0002.MP4' })}`, { token: mkt.token });
  assert.equal(l.status, 409);
  assert.equal(l.body.code, 'not_connected');
});

console.log('\n— Dropbox connected —');
connect(true);
await check('the folder is listed through its link (every page): sub-folders, files in camera order, counts and a summary', async () => {
  const r = await call('GET', `/marketing/media/folder?${q({ url: GOOD })}`, { token: mkt.token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.deepEqual(r.body.folders, [{ name: 'Stills', path: '/Stills' }]);
  assert.deepEqual(r.body.files.map((f) => [f.name, f.media, f.showable]), [
    ['C0002.MP4', 'video', true],
    ['C0010.MP4', 'video', true],
    ['notes.txt', 'other', false],
    ['Reveal · ദിയ.mov', 'video', true],
  ]);
  assert.equal(r.body.summary, '3 videos · 1 other file · 1 folder · 1 MB');
  assert.deepEqual(dbx.lists[0], { path: '', shared_link: { url: GOOD_CLEAN } }, 'the link as Dropbox needs it (rlkey kept, dl dropped), not recursive');
  assert.equal(dbx.lists[1].cursor, 'page2');
});
await check('a sub-folder opens; a place outside the folder, a file link, and people outside Marketing are refused', async () => {
  const r = await call('GET', `/marketing/media/folder?${q({ url: GOOD, path: '/Stills' })}`, { token: mkt.token });
  assert.deepEqual(r.body.files.map((f) => [f.path, f.media]), [['/Stills/IMG_1.jpg', 'picture']]);
  assert.equal((await call('GET', `/marketing/media/folder?${q({ url: GOOD, path: '/../etc' })}`, { token: mkt.token })).status, 400);
  assert.equal((await call('GET', `/marketing/media/folder?${q({ url: 'https://www.dropbox.com/scl/fi/a/clip.mp4?rlkey=x' })}`, { token: mkt.token })).status, 400);
  assert.equal((await call('GET', `/marketing/media/folder?${q({ url: GOOD })}`, { token: sales.token })).status, 403);
  assert.equal((await call('GET', `/marketing/media/folder?${q({ url: GOOD })}`)).status, 401);
});
await check('a folder Dropbox will not open for anyone says so in words — and is not remembered long', async () => {
  const r = await call('GET', `/marketing/media/folder?${q({ url: PRIVATE })}`, { token: mkt.token });
  assert.deepEqual([r.status, r.body.ok, r.body.code], [200, false, 'private']);
  assert.match(r.body.message, /Anyone with this link can view/);
});
await check('a list is remembered a few minutes; "fresh" lists again', async () => {
  const before = dbx.lists.length;
  await call('GET', `/marketing/media/folder?${q({ url: GOOD })}`, { token: mkt.token });
  assert.equal(dbx.lists.length, before, 'from memory');
  await call('GET', `/marketing/media/folder?${q({ url: GOOD, fresh: '1' })}`, { token: mkt.token });
  assert.equal(dbx.lists.length, before + 2, 'listed again (two pages)');
});

let clip;
await check('a video inside plays through the relay: pieces (206), the real type, not Dropbox\'s octet-stream, no login on the stream', async () => {
  const l = await call('GET', `/marketing/media/link?${q({ url: GOOD, path: '/C0002.MP4', probe: '1' })}`, { token: mkt.token });
  assert.equal(l.status, 200, JSON.stringify(l.body));
  assert.deepEqual([l.body.ok, l.body.fileName, l.body.size, l.body.type], [true, 'C0002.MP4', 2000, 'video/mp4']);
  clip = l.body.path;
  const r = await call('GET', clip, { headers: { range: 'bytes=100-199' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-type'), 'video/mp4');
  assert.equal(r.headers.get('content-range'), 'bytes 100-199/2000');
  assert.ok(r.buf.equals(FILES['/C0002.MP4'].subarray(100, 200)));
  const last = dbx.contents.at(-1);
  assert.deepEqual(last.arg, { url: GOOD_CLEAN, path: '/C0002.MP4' });
  assert.equal(last.range, 'bytes=100-199', 'the player\'s range passed on');
});
await check('a file named in Malayalam goes to Dropbox as plain ASCII and plays (a .mov as video/mp4); a picture shows as a picture', async () => {
  const l = await call('GET', `/marketing/media/link?${q({ url: GOOD, path: '/Reveal · ദിയ.mov' })}`, { token: mkt.token });
  assert.equal(l.status, 200, JSON.stringify(l.body));
  const r = await call('GET', l.body.path, { headers: { range: 'bytes=0-9' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-type'), 'video/mp4');
  assert.ok(/^[\x20-\x7e]*$/.test(dbx.contents.at(-1).rawArg));
  const p = await call('GET', `/marketing/media/link?${q({ url: GOOD, path: '/Stills/IMG_1.jpg' })}`, { token: mkt.token });
  const img = await call('GET', p.body.path);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.ok(img.buf.equals(FILES['/Stills/IMG_1.jpg']));
});
await check('a file the app cannot show, one not there, and a forged path are refused — each with its reason', async () => {
  const txt = await call('GET', `/marketing/media/link?${q({ url: GOOD, path: '/notes.txt' })}`, { token: mkt.token });
  assert.equal(txt.status, 400);
  assert.match(txt.body.message, /open it in Dropbox/);
  assert.equal((await call('GET', `/marketing/media/link?${q({ url: GOOD, path: '/../C0002.MP4' })}`, { token: mkt.token })).status, 400);
  const gone = await call('GET', `/marketing/media/link?${q({ url: GOOD, path: '/C9999.MP4', probe: '1' })}`, { token: mkt.token });
  assert.deepEqual([gone.status, gone.body.ok, gone.body.code], [200, false, 'missing']);
  const locked = await call('GET', `/marketing/media/link?${q({ url: PRIVATE, path: '/C0002.MP4', probe: '1' })}`, { token: mkt.token });
  assert.deepEqual([locked.body.ok, locked.body.code], [false, 'private']);
  // the path is signed: another path on the same token is not a token the server made
  const [payload, sig] = clip.split('/').pop().split('.');
  const body = JSON.parse(Buffer.from(payload, 'base64url').toString());
  const forged = `${Buffer.from(JSON.stringify({ ...body, p: '/C0010.MP4' })).toString('base64url')}.${sig}`;
  assert.equal((await call('GET', `/marketing/media/stream/${forged}`)).status, 403);
});
await check('a clip played in full is kept on disk: the next play does not reach Dropbox', async () => {
  const l = await call('GET', `/marketing/media/link?${q({ url: GOOD, path: '/C0010.MP4' })}`, { token: mkt.token });
  const first = await call('GET', l.body.path);
  assert.equal(first.status, 200);
  assert.ok(first.buf.equals(FILES['/C0010.MP4']));
  // this clip's own copy (the cache names a file by its folder link and path)
  const key = crypto.createHash('sha256').update(`${GOOD_CLEAN}#/C0010.MP4`).digest('hex').slice(0, 40);
  for (let i = 0; i < 100 && !fs.existsSync(path.join(cacheDir, `${key}.json`)); i += 1) await sleep(20);
  assert.ok(fs.existsSync(path.join(cacheDir, `${key}.json`)), 'the copy was made');
  const before = dbx.contents.length;
  const again = await call('GET', l.body.path, { headers: { range: 'bytes=0-99' } });
  assert.equal(again.status, 206);
  assert.ok(again.buf.equals(FILES['/C0010.MP4'].subarray(0, 100)));
  assert.equal(dbx.contents.length, before, 'from the copy on disk');
});
await check('Dropbox switched off after the address was given: the stream says why in words', async () => {
  const l = await call('GET', `/marketing/media/link?${q({ url: GOOD, path: '/C0002.MP4' })}`, { token: mkt.token });
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.mkdirSync(cacheDir);
  connect(false);
  const r = await call('GET', l.body.path, { headers: { range: 'bytes=0-9' } });
  assert.equal(r.status, 502);
  assert.equal(r.body.code, 'not_connected');
  assert.match(r.body.message, /Open the folder in Dropbox/);
  connect(true);
});

await check('an app without its permissions says which permission is missing and how to fix it — not "the key was refused"', async () => {
  dbx.noScope = true;
  _resetFolderListings();
  _resetMediaProbes();
  const r = await call('GET', `/marketing/media/folder?${q({ url: GOOD, fresh: '1' })}`, { token: mkt.token });
  assert.deepEqual([r.status, r.body.ok, r.body.code], [200, false, 'scope']);
  assert.match(r.body.message, /has not been given the permission "files\.metadata\.read"/);
  assert.match(r.body.message, /Permissions/);
  assert.doesNotMatch(r.body.message, /refused the CRM's key/);
  const l = await call('GET', `/marketing/media/link?${q({ url: GOOD, path: '/C0002.MP4', probe: '1' })}`, { token: mkt.token });
  assert.deepEqual([l.body.ok, l.body.code], [false, 'scope']);
  dbx.noScope = false;
  _resetFolderListings();
  _resetMediaProbes();
});

console.log('\n— the artist hands in a folder link —');
const today = istDayKey(new Date());
const yesterday = addDays(today, -1);
const at = (day, hh = 10) => new Date(`${day}T${String(hh).padStart(2, '0')}:00:00+05:30`);
const work = await Booking.create({ bookingNumber: 'BK-2001', customerName: 'Diya', service: 'Reception', bookingDate: at(yesterday), serviceStart: at(yesterday), serviceEnd: at(yesterday, 18), selectedDates: [yesterday], status: 'confirmed', totalPrice: 20000, contentCreationRequired: true, assignedStaff: [{ employeeId: ansha.emp._id, artistName: 'Ansha', roleType: 'lead' }] });
const add = (url) => call('POST', `/work-footage/booking/${work._id}/links`, { token: ansha.token, body: { day: yesterday, url } });
await check('a folder not shared with "anyone with the link" is sent back with how to share it — nothing is saved', async () => {
  const r = await add(PRIVATE);
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.message, /Share → set "Anyone with this link can view" → Copy link/);
  assert.equal(await WorkFootage.countDocuments({ bookingId: work._id, 'links.0': { $exists: true } }), 0);
  assert.equal(await Asset.countDocuments({ bookingId: work._id }), 0);
});
await check('a good folder goes in with what is in it ("3 videos · …"), and its size on the raw asset', async () => {
  const r = await add(GOOD);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const link = r.body.days.find((d) => d.day === yesterday).links[0];
  assert.equal(link.summary, '3 videos · 1 other file · 1 folder · 1 MB');
  const rec = await WorkFootage.findOne({ bookingId: work._id }).lean();
  assert.deepEqual([rec.links[0].videoCount, rec.links[0].pictureCount, rec.links[0].totalBytes], [3, 0, 6510]);
  const asset = await Asset.findById(rec.links[0].assetId).lean();
  assert.equal(asset.url, GOOD, 'the link as the artist sent it');
  assert.ok(asset.sizeMb >= 0 && asset.sizeMb < 1);
  const inbox = await call('GET', '/work-footage/inbox', { token: mkt.token });
  assert.equal(inbox.body.items[0].links[0].summary, link.summary, 'Marketing sees it too');
});
await check('Dropbox not answering never holds the artist up: the link goes in, without a summary', async () => {
  dbx.down = true;
  _resetFolderListings();
  const r = await add('https://www.dropbox.com/scl/fo/other/KEY9?rlkey=r9&dl=0');
  dbx.down = false;
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const links = r.body.days.find((d) => d.day === yesterday).links;
  assert.equal(links.length, 2);
  assert.equal(links[1].summary, '');
});
await check('without the Dropbox app the link goes in as it is (nothing asked of Dropbox)', async () => {
  connect(false);
  const before = dbx.lists.length;
  const r = await add('https://www.dropbox.com/scl/fo/third/KEY8?rlkey=r8&dl=0');
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(dbx.lists.length, before);
  connect(true);
});

server.close();
await mongoose.disconnect();
fs.rmSync(cacheDir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
