// End-to-end check of footage from works and the Shoot Planner's moodboard and logistics — against a THROWAWAY local MongoDB (needs a
// mongod on 127.0.0.1:27099; refuses to run against anything else and drops its database first) and a LOCAL stand-in Dropbox (an HTTP
// server on this machine — the real Dropbox is never called):
//
//   mkdir -p /tmp/lead-e2e && mongod --port 27099 --bind_ip 127.0.0.1 --dbpath /tmp/lead-e2e --fork --logpath /tmp/lead-e2e/log
//   node tests/e2e/work-footage.e2e.mjs
//
// The artist who worked a booking hands in its Dropbox link (or, with Dropbox connected, uploads through the work's upload page and the
// CRM finds the files); it becomes a raw asset under the shoot that covers the work, Marketing is told and sees it in Footage with the
// works still owing footage, and hands it to an editor (a task). The shoot's moodboard takes pictures and links from its own tab; its
// logistics keep who ticked what; moving the shoot moves the milestones not yet done.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import http from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
// NOTHING leaves this machine: every outbound key is blanked (the code loads the real .env, which never overrides a set variable)
for (const k of ['NODEMAILER_EMAIL', 'NODEMAILER_PASS', 'SMTP_HOST', 'MSG91_AUTHKEY', 'SMS_PROVIDER', 'TEAMN_CHAT_KEY', 'ORS_API_KEY', 'GEMINI_API_KEY', 'CLOUDFLARE_API_TOKEN', 'HF_TOKEN', 'POLLEN_KEY', 'REVIEW_AUTO_SEND_FROM', 'TIMEBOX_API_KEY', 'TIMEBOX_API_URL', 'CLOUDINARY_URL', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'META_APP_SECRET', 'META_SYSTEM_TOKEN', 'DROPBOX_ACCESS_TOKEN', 'DROPBOX_APP_KEY', 'DROPBOX_APP_SECRET', 'DROPBOX_REFRESH_TOKEN', 'DROPBOX_API_URL', 'DROPBOX_TOKEN_URL', 'DROPBOX_ROOT']) {
  process.env[k] = '';
}
await mongoose.connect('mongodb://127.0.0.1:27099/work_footage_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
await mongoose.connection.dropDatabase();

// ── a stand-in Dropbox ───────────────────────────────────────────────────────
const dbx = { folders: new Set(), requests: 0, files: [], refuse: false, calls: [] };
const dropbox = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    dbx.calls.push(req.url);
    const send = (status, json) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    if (req.headers.authorization !== 'Bearer test-token' || dbx.refuse) return send(401, { error_summary: 'invalid_access_token/' });
    if (req.url === '/2/files/create_folder_v2') {
      if (dbx.folders.has(body.path)) return send(409, { error_summary: 'path/conflict/folder/..', error: {} });
      dbx.folders.add(body.path);
      return send(200, { metadata: { path_display: body.path } });
    }
    if (req.url === '/2/file_requests/create') {
      dbx.requests += 1;
      return send(200, { id: `fr${dbx.requests}`, url: `https://www.dropbox.com/request/fr${dbx.requests}`, destination: body.destination });
    }
    if (req.url === '/2/files/list_folder') {
      if (!dbx.folders.has(body.path)) return send(409, { error_summary: 'path/not_found/..', error: {} });
      return send(200, { entries: dbx.files.map((f) => ({ '.tag': 'file', name: f.name, path_display: `${body.path}/${f.name}`, size: f.size, client_modified: f.at })), has_more: false, cursor: 'c' });
    }
    if (req.url === '/2/sharing/create_shared_link_with_settings') return send(200, { url: `https://www.dropbox.com/scl/fo/shared${encodeURIComponent(body.path).length}/folder?dl=0` });
    send(404, { error_summary: 'unknown' });
  });
});
dropbox.listen(0, '127.0.0.1');
await new Promise((r) => dropbox.once('listening', r));
const DROPBOX_URL = `http://127.0.0.1:${dropbox.address().port}`;

const root = new URL('../../', import.meta.url);
for (const f of readdirSync(new URL('models/', root))) await import(new URL(`models/${f}`, root));
const imp = (p) => import(new URL(p, root)).then((m) => m.default ?? m);
const User = await imp('models/User.js');
const Employee = await imp('models/Employee.js');
const Booking = await imp('models/Booking.js');
const Asset = await imp('models/MarketingAsset.js');
const Shoot = await imp('models/MarketingShoot.js');
const Task = await imp('models/MarketingTask.js');
const Notification = await imp('models/Notification.js');
const WorkFootage = await imp('models/WorkFootage.js');
const E = await import(new URL('models/MarketingEod.js', root));
const { ensureDefaultRoles } = await import(new URL('controllers/roleController.js', root));
const { sanitizeErrorResponses, errorHandler } = await import(new URL('middleware/errorMiddleware.js', root));
const { istDayKey, addDays } = await import(new URL('utils/istDate.js', root));
await import(new URL('utils/asyncErrors.js', root));
await ensureDefaultRoles();
await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));

const app = express();
app.use(express.json());
app.use(sanitizeErrorResponses);
app.use('/api/work-footage', await imp('routes/workFootageRoutes.js'));
app.use('/api/marketing/portfolio', await imp('routes/marketingPortfolioRoutes.js'));
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const origin = `http://127.0.0.1:${server.address().port}/api`;
const call = async (method, path, who, body) => {
  const res = await fetch(`${origin}${path}`, { method, headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${who.token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
};

let pass = 0;
const failures = [];
const check = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  ✔ ${name}`); } catch (e) { failures.push(name); console.log(`  ✖ ${name}\n      ${String(e.stack ?? e.message).split('\n').slice(0, 8).join('\n      ')}`); }
};

let n = 0;
const login = async (name, role, dept = 'Operations') => {
  n += 1;
  const emp = await Employee.create({ name, department: dept, status: 'active', artistRole: 'artist', phone: `90000000${String(n).padStart(2, '0')}` });
  const user = await User.create({ name, email: `u${n}@e2e.test`, password: 'secret123', role, employeeId: emp._id });
  return { id: String(user._id), emp, name, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
};
const anu = await login('Anu', 'artist');
const bina = await login('Bina', 'artist');
const boss = await login('Salmaan', 'marketing_admin', 'Marketing');
const { default: Role } = await import(new URL('models/Role.js', root));
await Role.updateOne({ key: 'marketing_staff' }, { $setOnInsert: { key: 'marketing_staff', label: 'Marketing staff', permissions: ['marketing'] } }, { upsert: true });
const shahala = await login('Shahala', 'marketing_staff', 'Marketing');
const ashique = await E.MarketingTeamMember.create({ name: 'Ashique', shortName: 'ASH', active: true });

const today = istDayKey(new Date());
const yesterday = addDays(today, -1);
const tomorrow = addDays(today, 1);
const at = (day, hh = 10) => new Date(`${day}T${String(hh).padStart(2, '0')}:00:00+05:30`);
const work = (extra) => Booking.create({ customerName: 'Amina K', service: 'Bridal Makeup', bookingDate: at(yesterday), serviceStart: at(yesterday), serviceEnd: at(yesterday, 18), status: 'confirmed', totalPrice: 30000, ...extra });
const b1 = await work({ bookingNumber: 'BK-1001', selectedDates: [yesterday, tomorrow], assignedStaff: [{ employeeId: anu.emp._id, artistName: 'Anu', roleType: 'lead' }], contentCreationRequired: true });
const b2 = await work({ bookingNumber: 'BK-1002', customerName: 'Diya', selectedDates: [yesterday], bookingItems: [{ service: 'Reception', selectedDates: [yesterday], assignedStaff: [{ employeeId: bina.emp._id, artistName: 'Bina' }] }] });
const b3 = await work({ bookingNumber: 'BK-1003', customerName: 'No content', selectedDates: [yesterday], assignedStaff: [{ employeeId: bina.emp._id, artistName: 'Bina' }] });
// a shoot covers b2 — so it needs content though the booking does not say so
const shoot = await Shoot.create({ title: 'Diya reception film', brand: 'kerala', category: 'Reception', shootDate: yesterday, bookingId: b2._id, milestones: [{ key: 'brief', date: addDays(yesterday, -5), doneAt: new Date() }, { key: 'production', date: yesterday, doneAt: null }, { key: 'distribution', date: addDays(yesterday, 4), doneAt: null }] });

const FOLDER = `${yesterday} · BK-1001 · Amina K · Bridal Makeup`;

console.log('\n— the artist hands in the footage —');
await check('the artist sees each work day with its folder name; due once the day has come; another artist and outsiders are refused', async () => {
  const r = await call('GET', `/work-footage/booking/${b1._id}`, anu);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.days.map((d) => [d.day, d.state, d.due]), [[yesterday, 'waiting', true], [tomorrow, 'waiting', false]]);
  assert.equal(r.body.days[0].folderName, FOLDER);
  assert.deepEqual([r.body.canAdd, r.body.isMarketing, r.body.dropbox.enabled, r.body.needsContent], [true, false, false, true]);
  assert.equal((await call('GET', `/work-footage/booking/${b1._id}`, bina)).status, 403);
  assert.equal((await call('GET', `/work-footage/booking/${b2._id}`, bina)).status, 200, 'assigned through a package of the booking');
  assert.equal((await call('GET', `/work-footage/booking/${b1._id}`, shahala)).status, 200, 'Marketing reads every work');
});
let firstLink;
await check('a link that is not Dropbox, or for a day still to come, is refused with the reason; the Dropbox link goes in once', async () => {
  const bad = await call('POST', `/work-footage/booking/${b1._id}/links`, anu, { day: yesterday, url: 'https://wetransfer.com/x' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.message, /Only Dropbox/);
  assert.equal((await call('POST', `/work-footage/booking/${b1._id}/links`, anu, { day: tomorrow, url: 'https://www.dropbox.com/scl/fo/a/b' })).status, 400);
  assert.equal((await call('POST', `/work-footage/booking/${b1._id}/links`, anu, { day: '2020-01-01', url: 'https://www.dropbox.com/scl/fo/a/b' })).status, 400, 'not one of its days');
  const r = await call('POST', `/work-footage/booking/${b1._id}/links`, anu, { day: yesterday, url: 'https://www.dropbox.com/scl/fo/abc/folder?rlkey=x&dl=0', label: 'All clips' });
  assert.equal(r.status, 201, r.text);
  const d = r.body.days[0];
  assert.deepEqual([d.state, d.due, d.links.length, d.links[0].mine, d.links[0].kind], ['new', false, 1, true, 'folder']);
  firstLink = d.links[0];
  assert.equal((await call('POST', `/work-footage/booking/${b1._id}/links`, anu, { day: yesterday, url: 'https://www.dropbox.com/scl/fo/abc/folder?dl=1' })).status, 409, 'the same link again');
});
await check('it becomes a RAW video asset in Marketing\'s library (the work\'s name, the artist as owner) and Marketing is told', async () => {
  const a = await Asset.findOne({ bookingId: b1._id }).lean();
  assert.deepEqual([a.stage, a.media, a.ownerName, a.workDay, a.shootId], ['raw', 'video', 'Anu', yesterday, null]);
  assert.equal(a.title, `${FOLDER} — All clips`);
  assert.ok(a.tags.includes('raw footage'));
  const note = await Notification.findOne({ type: 'footage_uploaded' }).lean();
  assert.equal(String(note.recipient), boss.id);
  assert.match(note.body, /Anu added the footage of/);
});
await check('a work a shoot covers files its footage under that shoot (its brand and category)', async () => {
  const r = await call('POST', `/work-footage/booking/${b2._id}/links`, bina, { url: 'https://www.dropbox.com/scl/fi/xyz/reception.mp4?dl=0' });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.days[0].day, yesterday, 'no day asked: the latest that has come');
  const a = await Asset.findOne({ bookingId: b2._id }).lean();
  assert.deepEqual([String(a.shootId), a.brand, a.portfolio], [String(shoot._id), 'kerala', 'Kerala']);
  assert.ok(a.tags.includes('reception'));
  const d = (await call('GET', `/marketing/portfolio/shoots/${shoot._id}`, shahala)).body;
  assert.deepEqual(d.footage.map((f) => [f.day, f.state, f.links.length]), [[yesterday, 'new', 1]], 'the shoot shows its work\'s footage');
});

console.log('\n— Marketing\'s footage inbox —');
await check('the inbox lists the footage newest first and the works still owing it (only those that need content); artists cannot open it', async () => {
  assert.equal((await call('GET', '/work-footage/inbox', anu)).status, 403);
  await call('DELETE', `/work-footage/booking/${b2._id}/links/${(await WorkFootage.findOne({ bookingId: b2._id })).links[0]._id}`, bina);
  const r = await call('GET', '/work-footage/inbox', shahala);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.items.map((i) => [i.bookingNumber, i.status, i.uploaders]), [['BK-1001', 'new', ['Anu']]]);
  assert.deepEqual(r.body.waiting.map((w) => [w.bookingNumber, w.day, w.artists]), [['BK-1002', yesterday, ['Bina']]], 'b2 again owes footage; b3 needs none; b1 tomorrow not yet');
  assert.equal(r.body.counts.waiting, 1);
});
await check('handing to an editor makes a task on their Team Dashboard; then edited', async () => {
  const rec = await WorkFootage.findOne({ bookingId: b1._id });
  assert.equal((await call('PATCH', `/work-footage/${rec._id}`, anu, { status: 'edited' })).status, 403);
  assert.equal((await call('PATCH', `/work-footage/${rec._id}`, shahala, { status: 'in_edit' })).status, 400, 'choose the editor');
  const r = await call('PATCH', `/work-footage/${rec._id}`, shahala, { status: 'in_edit', editorMemberId: String(ashique._id) });
  assert.equal(r.status, 200, r.text);
  const task = await Task.findById(r.body.taskId).lean();
  assert.deepEqual([String(task.assigneeId), task.dueDate], [String(ashique._id), addDays(today, 3)]);
  assert.match(task.title, /Edit the footage — /);
  assert.equal(task.attachments[0].url, firstLink.url);
  assert.equal((await call('PATCH', `/work-footage/${rec._id}`, shahala, { status: 'edited' })).body.status, 'edited');
  assert.equal(await Task.countDocuments(), 1, 'one task');
});
await check('a link comes off only by whoever added it or a Marketing Manager; its raw asset goes with it', async () => {
  assert.equal((await call('DELETE', `/work-footage/booking/${b1._id}/links/${firstLink.id}`, shahala)).status, 403, 'Marketing staff, not the adder');
  assert.equal((await call('DELETE', `/work-footage/booking/${b1._id}/links/${firstLink.id}`, boss)).status, 200);
  assert.equal(await Asset.countDocuments({ bookingId: b1._id }), 0);
});

console.log('\n— with Dropbox connected —');
await check('not connected: the upload page says so plainly', async () => {
  const r = await call('POST', `/work-footage/booking/${b1._id}/upload-page`, anu, { day: yesterday });
  assert.equal(r.status, 409);
  assert.match(r.body.message, /not connected/);
});
await check('the work\'s upload page: its folder made under the month, a file request made once and reused', async () => {
  process.env.DROPBOX_ACCESS_TOKEN = 'test-token';
  process.env.DROPBOX_API_URL = DROPBOX_URL;
  const r = await call('POST', `/work-footage/booking/${b1._id}/upload-page`, anu, { day: yesterday });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.url, 'https://www.dropbox.com/request/fr1');
  assert.equal(r.body.folderPath, `/Team N Works/${yesterday.slice(0, 7)}/${FOLDER}`);
  assert.ok(dbx.folders.has(r.body.folderPath));
  assert.equal((await call('POST', `/work-footage/booking/${b1._id}/upload-page`, anu, { day: yesterday })).body.url, 'https://www.dropbox.com/request/fr1');
  assert.equal(dbx.requests, 1);
});
await check('checking the upload: the files and their size are recorded; the folder is shared and its link added once (as a raw asset with its size)', async () => {
  const empty = (await call('POST', `/work-footage/booking/${b1._id}/check`, anu, { day: yesterday })).body;
  assert.equal(empty.found, 0);
  assert.equal(empty.days[0].state, 'waiting');
  dbx.files = [{ name: 'clip1.mp4', size: 700 * 1024 * 1024, at: `${yesterday}T10:00:00Z` }, { name: 'clip2.mov', size: 900 * 1024 * 1024, at: `${yesterday}T11:00:00Z` }];
  const r = (await call('POST', `/work-footage/booking/${b1._id}/check`, anu, { day: yesterday })).body;
  assert.equal(r.found, 2);
  const d = r.days[0];
  assert.deepEqual([d.state, d.size, d.files.map((f) => f.name), d.links.map((l) => l.source)], ['new', '1.6 GB', ['clip2.mov', 'clip1.mp4'], ['dropbox']]);
  const a = await Asset.findOne({ bookingId: b1._id }).lean();
  assert.equal(a.sizeMb, 1600);
  await call('POST', `/work-footage/booking/${b1._id}/check`, anu, { day: yesterday });
  assert.equal((await WorkFootage.findOne({ bookingId: b1._id, day: yesterday })).links.length, 1, 'not shared twice');
});
await check('Dropbox refusing the key: said in words, nothing broken', async () => {
  dbx.refuse = true;
  const r = await call('POST', `/work-footage/booking/${b1._id}/check`, anu, { day: yesterday });
  assert.equal(r.status, 502);
  assert.match(r.body.message, /Dropbox refused the CRM's key/);
  dbx.refuse = false;
  process.env.DROPBOX_ACCESS_TOKEN = '';
  process.env.DROPBOX_API_URL = '';
});

console.log('\n— the Shoot Planner: moodboard, logistics, milestones —');
await check('the moodboard takes pictures and links from its own tab — each once, labelled, with who added it; a label changes; an item comes off', async () => {
  const r = await call('POST', `/marketing/portfolio/shoots/${shoot._id}/moodboard`, shahala, { items: [{ url: 'https://res.cloudinary.com/x/image/upload/v1/look.jpg', label: 'Look' }, { url: 'https://www.pinterest.com/pin/9/' }] });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(r.body.references.map((x) => [x.kind, x.addedByName]), [['image', 'Shahala'], ['link', 'Shahala']]);
  const again = await call('POST', `/marketing/portfolio/shoots/${shoot._id}/moodboard`, shahala, { items: [{ url: 'https://www.pinterest.com/pin/9/' }] });
  assert.deepEqual([again.body.added, again.body.skipped], [0, 1]);
  const named = await call('PATCH', `/marketing/portfolio/shoots/${shoot._id}/moodboard`, shahala, { url: 'https://www.pinterest.com/pin/9/', label: 'Hair idea' });
  assert.equal(named.body.references[1].label, 'Hair idea');
  const off = await call('DELETE', `/marketing/portfolio/shoots/${shoot._id}/moodboard?url=${encodeURIComponent('https://www.pinterest.com/pin/9/')}`, shahala);
  assert.equal(off.body.references.length, 1);
  assert.equal((await call('POST', `/marketing/portfolio/shoots/${shoot._id}/moodboard`, shahala, { items: [{ url: 'javascript:alert(1)' }] })).status, 400);
  const d = (await call('GET', `/marketing/portfolio/shoots/${shoot._id}`, shahala)).body;
  assert.equal(d.references[0].label, 'Look');
  // an edit of the plan that leaves the moodboard out keeps it
  await call('PUT', `/marketing/portfolio/shoots/${shoot._id}`, shahala, { title: 'Diya reception film v2' });
  assert.equal((await Shoot.findById(shoot._id).lean()).references.length, 1);
  // Camera Movement: its own pictures and video links (a YouTube or Instagram reel plays as a video), labelled, removed — never on the moodboard
  const cam = await call('POST', `/marketing/portfolio/shoots/${shoot._id}/camera`, shahala, { items: [{ url: 'https://res.cloudinary.com/x/image/upload/v1/dolly-diagram.jpg', label: 'Dolly in' }, { url: 'https://www.instagram.com/reel/Cx9/' }, { url: 'https://youtu.be/gimbal1' }] });
  assert.equal(cam.status, 201, cam.text);
  assert.deepEqual(cam.body.cameraRefs.map((x) => [x.kind, x.label, x.addedByName]), [['image', 'Dolly in', 'Shahala'], ['video', '', 'Shahala'], ['video', '', 'Shahala']]);
  const camNamed = await call('PATCH', `/marketing/portfolio/shoots/${shoot._id}/camera`, shahala, { url: 'https://youtu.be/gimbal1', label: 'Gimbal orbit' });
  assert.equal(camNamed.body.cameraRefs[2].label, 'Gimbal orbit');
  const camOff = await call('DELETE', `/marketing/portfolio/shoots/${shoot._id}/camera?url=${encodeURIComponent('https://www.instagram.com/reel/Cx9/')}`, shahala);
  assert.equal(camOff.body.cameraRefs.length, 2);
  const missing = await call('DELETE', `/marketing/portfolio/shoots/${shoot._id}/camera?url=${encodeURIComponent('https://www.pinterest.com/pin/9/')}`, shahala);
  assert.deepEqual([missing.status, missing.body.message], [404, 'That picture or link is not on the camera movement plan.']);
  const both = (await call('GET', `/marketing/portfolio/shoots/${shoot._id}`, shahala)).body;
  assert.deepEqual([both.references.length, both.cameraRefs.map((x) => x.label)], [1, ['Dolly in', 'Gimbal orbit']]);
  await call('PUT', `/marketing/portfolio/shoots/${shoot._id}`, shahala, { title: 'Diya reception film v2' });
  assert.equal((await Shoot.findById(shoot._id).lean()).cameraRefs.length, 2, 'an edit of the plan keeps them too');
});
await check('logistics: call time, map, checklist with who ticked what, notes', async () => {
  const r = await call('PUT', `/marketing/portfolio/shoots/${shoot._id}/logistics`, shahala, { callTime: '06:30', mapUrl: 'https://maps.app.goo.gl/abc', checklist: [{ text: 'Ring light' }, { text: 'Steamer', done: true }], notes: 'Park at gate 2' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.logistics.checklist.map((c) => [c.text, c.done, c.byName]), [['Ring light', false, ''], ['Steamer', true, 'Shahala']]);
  assert.equal((await call('PUT', `/marketing/portfolio/shoots/${shoot._id}/logistics`, shahala, { callTime: '6.30' })).status, 400);
  const d = (await call('GET', `/marketing/portfolio/shoots/${shoot._id}`, shahala)).body;
  assert.deepEqual([d.logistics.callTime, d.logistics.notes], ['06:30', 'Park at gate 2']);
});
await check('the checklist on the shoot day: two people ticking at once never undo each other; a line not there is a 404', async () => {
  // both tick from the same screen at the same moment (each sends only their line)
  const [a, b] = await Promise.all([
    call('PATCH', `/marketing/portfolio/shoots/${shoot._id}/logistics/check`, shahala, { text: 'Ring light', done: true }),
    call('PATCH', `/marketing/portfolio/shoots/${shoot._id}/logistics/check`, boss, { text: 'Steamer', done: false }),
  ]);
  assert.equal(a.status, 200, a.text);
  assert.equal(b.status, 200, b.text);
  const list = (await Shoot.findById(shoot._id).lean()).logistics.checklist;
  assert.deepEqual(list.map((c) => [c.text, c.done, c.byName]), [['Ring light', true, 'Shahala'], ['Steamer', false, '']]);
  assert.equal((await call('PATCH', `/marketing/portfolio/shoots/${shoot._id}/logistics/check`, shahala, { text: 'Drone', done: true })).status, 404);
  assert.equal((await call('PATCH', `/marketing/portfolio/shoots/${shoot._id}/logistics/check`, shahala, { text: 'Ring light' })).status, 400, 'done must be said');
});
let frames;
await check('the storyboard: frames with pictures (https only); each frame has its own key', async () => {
  const bad = await call('PUT', `/marketing/portfolio/shoots/${shoot._id}`, shahala, { storyboard: [{ description: 'Walk in', imageUrl: 'javascript:alert(1)' }] });
  assert.equal(bad.status, 400);
  const r = await call('PUT', `/marketing/portfolio/shoots/${shoot._id}`, shahala, { storyboard: [{ description: 'Walk in', shotType: 'Wide', imageUrl: 'https://res.cloudinary.com/x/image/upload/v1/sketch1.jpg' }, { description: 'Eyes', shotType: 'Close-up' }, { description: 'Jewellery' }] });
  assert.equal(r.status, 200, r.text);
  const d = (await call('GET', `/marketing/portfolio/shoots/${shoot._id}`, shahala)).body;
  frames = d.storyboard;
  assert.deepEqual(frames.map((f) => [f.shotNo, f.description, f.imageUrl, f.shotAt]), [['1', 'Walk in', 'https://res.cloudinary.com/x/image/upload/v1/sketch1.jpg', null], ['2', 'Eyes', '', null], ['3', 'Jewellery', '', null]]);
  assert.equal(new Set(frames.map((f) => f.key)).size, 3);
  assert.deepEqual(d.shotProgress, { total: 3, shot: 0, pct: 0 });
});
await check('on the shoot day frames are ticked as shot — at once by two people, neither undone; who and when is kept', async () => {
  const [a, b] = await Promise.all([
    call('PATCH', `/marketing/portfolio/shoots/${shoot._id}/storyboard/${frames[0].key}`, shahala, { shot: true }),
    call('PATCH', `/marketing/portfolio/shoots/${shoot._id}/storyboard/${frames[2].key}`, boss, { shot: true }),
  ]);
  assert.equal(a.status, 200, a.text);
  assert.equal(b.status, 200, b.text);
  const d = (await call('GET', `/marketing/portfolio/shoots/${shoot._id}`, shahala)).body;
  assert.deepEqual(d.storyboard.map((f) => [f.description, f.shotByName, !!f.shotAt]), [['Walk in', 'Shahala', true], ['Eyes', '', false], ['Jewellery', 'Salmaan', true]]);
  assert.deepEqual(d.shotProgress, { total: 3, shot: 2, pct: 67 });
  const off = await call('PATCH', `/marketing/portfolio/shoots/${shoot._id}/storyboard/${frames[2].key}`, boss, { shot: false });
  assert.deepEqual(off.body.storyboard.map((f) => !!f.shotAt), [true, false, false]);
  assert.equal((await call('PATCH', `/marketing/portfolio/shoots/${shoot._id}/storyboard/nope1234`, shahala, { shot: true })).status, 404);
  assert.equal((await call('PATCH', `/marketing/portfolio/shoots/${shoot._id}/storyboard/${frames[0].key}`, shahala, { shot: 'yes' })).status, 400);
});
await check('editing the storyboard (reorder, change, add) keeps the ticks of the frames that stay; a tick cannot be sent with an edit', async () => {
  const [walk, eyes] = frames;
  const r = await call('PUT', `/marketing/portfolio/shoots/${shoot._id}`, shahala, {
    storyboard: [{ key: eyes.key, description: 'Eyes, slow motion', shotAt: '2020-01-01', shotByName: 'Forged' }, { key: walk.key, description: 'Walk in (wide)', imageUrl: walk.imageUrl }, { description: 'Hands with henna' }],
  });
  assert.equal(r.status, 200, r.text);
  const d = (await call('GET', `/marketing/portfolio/shoots/${shoot._id}`, shahala)).body;
  assert.deepEqual(d.storyboard.map((f) => [f.description, f.shotByName, !!f.shotAt, f.imageUrl !== '']), [['Eyes, slow motion', '', false, false], ['Walk in (wide)', 'Shahala', true, true], ['Hands with henna', '', false, false]]);
  assert.equal(d.storyboard[1].key, walk.key);
  // an edit of the plan that leaves the storyboard out keeps it, ticks and all
  await call('PUT', `/marketing/portfolio/shoots/${shoot._id}`, shahala, { location: 'Kumarakom lake' });
  assert.equal((await call('GET', `/marketing/portfolio/shoots/${shoot._id}`, shahala)).body.shotProgress.shot, 1);
});
await check('frames saved before frames had keys get one when the shoot is opened, and can then be ticked', async () => {
  await Shoot.updateOne({ _id: shoot._id }, { $set: { storyboard: [{ shotNo: '1', description: 'Old frame' }, { shotNo: '2', description: 'Another' }] } });
  const d = (await call('GET', `/marketing/portfolio/shoots/${shoot._id}`, shahala)).body;
  assert.ok(d.storyboard.every((f) => f.key), 'keys given');
  assert.deepEqual((await Shoot.findById(shoot._id).lean()).storyboard.map((f) => f.key), d.storyboard.map((f) => f.key), 'and kept');
  assert.equal((await call('PATCH', `/marketing/portfolio/shoots/${shoot._id}/storyboard/${d.storyboard[1].key}`, shahala, { shot: true })).status, 200);
});
// ── PDFs on the moodboard and the storyboard (a stand-in store: nothing reaches Cloudinary) ──
const { _setShootFileStore } = await import(new URL('services/shootFiles.js', root));
const kept = new Map();
const removedIds = [];
_setShootFileStore({
  put: async (buffer, name) => {
    const id = `shoot_docs/${kept.size + 1}_${name}`;
    kept.set(`https://store.test/${id}`, Buffer.from(buffer));
    return { url: `https://store.test/${id}`, id };
  },
  get: async (url, id) => {
    if (!kept.has(url) || !id) throw new Error('gone'); // read with the file's id (the signed download needs it)
    return kept.get(url);
  },
  remove: async (id) => removedIds.push(id),
});
const pdfOf = (pages, pad = 0) => Buffer.concat([Buffer.from(`%PDF-1.4\n${Array.from({ length: pages }, (_, i) => `${i + 3} 0 obj << /Type /Page /Parent 2 0 R >> endobj\n`).join('')}2 0 obj << /Type /Pages /Count ${pages} >> endobj\n`), Buffer.alloc(pad, 32), Buffer.from('%%EOF')]);
const upload = async (who, fields, file) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  if (file) form.append('file', new Blob([file.bytes], { type: file.type ?? 'application/pdf' }), file.name);
  const res = await fetch(`${origin}/marketing/portfolio/shoots/${shoot._id}/documents`, { method: 'POST', headers: { authorization: `Bearer ${who.token}` }, body: form });
  const text = await res.text();
  let body = {};
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body, text };
};
let lookbook;
await check('a PDF goes on the moodboard or the storyboard — its name, pages, size and who added it; where it is kept is never shown', async () => {
  const r = await upload(shahala, { part: 'moodboard', label: 'Bridal lookbook' }, { bytes: pdfOf(3), name: 'C:\\Users\\x\\Lookbook Nov.pdf' });
  assert.equal(r.status, 201, r.text);
  lookbook = r.body.added;
  assert.deepEqual([lookbook.part, lookbook.name, lookbook.label, lookbook.pages, lookbook.addedByName], ['moodboard', 'Lookbook Nov.pdf', 'Bridal lookbook', 3, 'Shahala']);
  assert.ok(lookbook.sizeBytes > 0);
  assert.ok(!JSON.stringify(r.body).includes('store.test'), 'the stored address is not handed out');
  // a name with a character past ASCII (as the real upload had: "Flow · Team N") arrives right, not "Flow Â· Team N"
  const dotted = await upload(shahala, { part: 'moodboard' }, { bytes: pdfOf(1), name: 'Marketing Flow · Team N.pdf' });
  assert.equal(dotted.body.added?.name, 'Marketing Flow · Team N.pdf', dotted.text);
  await call('DELETE', `/marketing/portfolio/shoots/${shoot._id}/documents/${dotted.body.added.key}`, shahala);
  removedIds.length = 0;
  const s2 = await upload(boss, { part: 'storyboard' }, { bytes: pdfOf(12), name: 'storyboard-v2' });
  assert.equal(s2.status, 201, s2.text);
  assert.deepEqual([s2.body.added.name, s2.body.added.pages], ['storyboard-v2.pdf', 12]);
  const d = (await call('GET', `/marketing/portfolio/shoots/${shoot._id}`, shahala)).body;
  assert.deepEqual(d.documents.map((x) => [x.part, x.name]), [['moodboard', 'Lookbook Nov.pdf'], ['storyboard', 'storyboard-v2.pdf']]);
});
await check('only a real PDF is taken: a renamed picture, no file, no place, too big (25 MB) are refused with the reason', async () => {
  const pic = await upload(shahala, { part: 'moodboard' }, { bytes: Buffer.from('GIF89a......'), name: 'look.pdf' });
  assert.deepEqual([pic.status, /not a PDF/.test(pic.body.message)], [400, true]);
  assert.equal((await upload(shahala, { part: 'moodboard' }, null)).status, 400);
  assert.equal((await upload(shahala, { part: 'gallery' }, { bytes: pdfOf(1), name: 'a.pdf' })).status, 400);
  const big = await upload(shahala, { part: 'moodboard' }, { bytes: pdfOf(1, 26 * 1024 * 1024), name: 'huge.pdf' });
  assert.equal(big.status, 413, big.text);
  assert.match(big.body.message, /25 MB/);
});
await check('the PDF is read in the app (inline) or saved (?download=1); people outside Marketing and unknown files are refused', async () => {
  const res = await fetch(`${origin}/marketing/portfolio/shoots/${shoot._id}/documents/${lookbook.key}`, { headers: { authorization: `Bearer ${shahala.token}` } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.match(res.headers.get('content-disposition'), /^inline; filename="Lookbook Nov\.pdf"/);
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(pdfOf(3)));
  const dl = await fetch(`${origin}/marketing/portfolio/shoots/${shoot._id}/documents/${lookbook.key}?download=1`, { headers: { authorization: `Bearer ${shahala.token}` } });
  assert.match(dl.headers.get('content-disposition'), /^attachment/);
  assert.equal((await call('GET', `/marketing/portfolio/shoots/${shoot._id}/documents/${lookbook.key}`, anu)).status, 403, 'an artist is not Marketing');
  assert.equal((await fetch(`${origin}/marketing/portfolio/shoots/${shoot._id}/documents/${lookbook.key}`)).status, 401, 'no login, no file');
  assert.equal((await call('GET', `/marketing/portfolio/shoots/${shoot._id}/documents/nope`, shahala)).status, 404);
});
await check('a PDF is renamed and removed (and let go from storage); two uploads at once both stay; 20 per place at most', async () => {
  const r = await call('PATCH', `/marketing/portfolio/shoots/${shoot._id}/documents/${lookbook.key}`, shahala, { label: 'Lookbook — final' });
  assert.equal(r.body.documents.find((x) => x.key === lookbook.key).label, 'Lookbook — final');
  const off = await call('DELETE', `/marketing/portfolio/shoots/${shoot._id}/documents/${lookbook.key}`, shahala);
  assert.equal(off.status, 200, off.text);
  assert.ok(!off.body.documents.some((x) => x.key === lookbook.key));
  assert.equal(removedIds.length, 1);
  assert.match(removedIds[0], /Lookbook Nov\.pdf$/);
  const [a, b] = await Promise.all([upload(shahala, { part: 'moodboard' }, { bytes: pdfOf(1), name: 'one.pdf' }), upload(boss, { part: 'moodboard' }, { bytes: pdfOf(1), name: 'two.pdf' })]);
  assert.deepEqual([a.status, b.status], [201, 201]);
  const now = (await Shoot.findById(shoot._id).lean()).documents.filter((x) => x.part === 'moodboard').map((x) => x.name).sort();
  assert.deepEqual(now, ['one.pdf', 'two.pdf']);
  for (let i = 0; i < 18; i += 1) assert.equal((await upload(shahala, { part: 'moodboard' }, { bytes: pdfOf(1), name: `m${i}.pdf` })).status, 201);
  const over = await upload(shahala, { part: 'moodboard' }, { bytes: pdfOf(1), name: 'twenty-one.pdf' });
  assert.equal(over.status, 400);
  assert.match(over.body.message, /up to 20/);
  assert.equal((await upload(shahala, { part: 'storyboard' }, { bytes: pdfOf(1), name: 'still-room.pdf' })).status, 201, 'the storyboard has its own 20');
  // the camera movement plan: its own PDFs (and its own 20), read back with the rest
  const cam = await upload(shahala, { part: 'camera', label: 'Gimbal + dolly moves' }, { bytes: pdfOf(4), name: 'camera-moves.pdf' });
  assert.equal(cam.status, 201, cam.text);
  assert.deepEqual([cam.body.added.part, cam.body.added.label, cam.body.added.pages], ['camera', 'Gimbal + dolly moves', 4]);
  const read = await call('GET', `/marketing/portfolio/shoots/${shoot._id}/documents/${cam.body.added.key}`, shahala);
  assert.equal(read.status, 200);
  assert.equal((await upload(shahala, { part: 'lighting' }, { bytes: pdfOf(1), name: 'x.pdf' })).status, 400, 'only the three places');
});
await check('moving the shoot moves its milestones not yet done by the same days; the done brief stays', async () => {
  const before = (await Shoot.findById(shoot._id).lean()).milestones;
  const newDay = addDays(yesterday, 10);
  const r = await call('PUT', `/marketing/portfolio/shoots/${shoot._id}`, shahala, { shootDate: newDay });
  assert.equal(r.status, 200, r.text);
  const after = new Map((await Shoot.findById(shoot._id).lean()).milestones.map((m) => [m.key, m.date]));
  assert.equal(after.get('brief'), before.find((m) => m.key === 'brief').date, 'done: stays');
  assert.equal(after.get('production'), newDay);
  assert.equal(after.get('distribution'), addDays(newDay, 4));
  assert.equal(r.body.delayed ?? false, false, 'not "Delayed" just because it moved');
});

await mongoose.connection.dropDatabase();
server.close();
dropbox.close();
await mongoose.disconnect();
console.log(`\n${pass} passed${failures.length ? `, ${failures.length} FAILED:\n - ${failures.join('\n - ')}` : ''}`);
process.exit(failures.length ? 1 : 0);
