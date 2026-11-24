// End-to-end check of the gallery's link to the WORK behind each photo / video and the client's review of it, and the Artist Quality
// view — against a THROWAWAY local MongoDB (needs a mongod on 127.0.0.1:27099; refuses to run against anything else and drops its
// database first):
//
//   mkdir -p /tmp/lead-e2e && mongod --port 27099 --bind_ip 127.0.0.1 --dbpath /tmp/lead-e2e --fork --logpath /tmp/lead-e2e/log
//   node tests/e2e/gallery-work-review.e2e.mjs
//
// Works (bookings) with their artists, the reviews the CRM sends the morning after (answered, a complaint, still waiting, none), and
// gallery items that reach a work three ways (an artist's footage, a shoot that covers the booking, a booking picked in the editor).
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import crypto from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
// NOTHING leaves this machine: the code under test loads the real .env (dotenv does not override a variable that is already set, even
// to ''), so every outbound service's key is blanked first.
for (const k of ['NODEMAILER_EMAIL', 'NODEMAILER_PASS', 'SMTP_HOST', 'MSG91_AUTHKEY', 'SMS_PROVIDER', 'TEAMN_CHAT_KEY', 'ORS_API_KEY', 'GEMINI_API_KEY', 'CLOUDFLARE_API_TOKEN', 'HF_TOKEN', 'POLLEN_KEY', 'REVIEW_AUTO_SEND_FROM', 'TIMEBOX_API_KEY', 'TIMEBOX_API_URL', 'CLOUDINARY_URL', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'META_APP_SECRET', 'META_SYSTEM_TOKEN', 'DROPBOX_APP_KEY', 'DROPBOX_APP_SECRET', 'DROPBOX_REFRESH_TOKEN', 'DROPBOX_ACCESS_TOKEN']) {
  process.env[k] = '';
}
await mongoose.connect('mongodb://127.0.0.1:27099/gallery_work_review_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
await mongoose.connection.dropDatabase();

const root = new URL('../../', import.meta.url);
for (const f of readdirSync(new URL('models/', root))) await import(new URL(`models/${f}`, root));
const imp = (p) => import(new URL(p, root)).then((m) => m.default ?? m);
const User = await imp('models/User.js');
const Employee = await imp('models/Employee.js');
const Booking = await imp('models/Booking.js');
const Review = await imp('models/Review.js');
const Shoot = await imp('models/MarketingShoot.js');
const Asset = await imp('models/MarketingAsset.js');
const { ensureDefaultRoles } = await import(new URL('controllers/roleController.js', root));
const { sanitizeErrorResponses, errorHandler } = await import(new URL('middleware/errorMiddleware.js', root));
await import(new URL('utils/asyncErrors.js', root));
await ensureDefaultRoles();
await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
assert.equal(process.env.CLOUDINARY_API_SECRET, '', 'SAFETY: config/cloudinary.js must not have reloaded .env');

const app = express();
app.use(express.json());
app.use(sanitizeErrorResponses);
app.use('/api/marketing/socials', await imp('routes/marketingSocialsRoutes.js'));
app.use('/api/marketing/portfolio', await imp('routes/marketingPortfolioRoutes.js'));
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const origin = `http://127.0.0.1:${server.address().port}/api/marketing`;

const call = async (method, path, who, body) => {
  const res = await fetch(`${origin}${path}`, { method, headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${who.token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
};
const list = async (who, params = {}) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) for (const x of Array.isArray(v) ? v : [v]) u.append(k, String(x));
  const r = await call('GET', `/socials/assets?${u}`, who);
  assert.equal(r.status, 200, r.text);
  return r.body;
};
const titles = (l) => l.items.map((a) => a.title).sort();

let pass = 0;
const failures = [];
const check = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  ✔ ${name}`); } catch (e) { failures.push(name); console.log(`  ✖ ${name}\n      ${String(e.stack ?? e.message).split('\n').slice(0, 8).join('\n      ')}`); }
};

let n = 0;
const login = async (name, role) => {
  n += 1;
  const emp = await Employee.create({ name, department: 'Marketing' });
  const user = await User.create({ name, email: `u${n}@e2e.test`, password: 'secret123', role, employeeId: emp._id });
  return { id: String(user._id), name, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
};
const boss = await login('Boss', 'marketing_admin');
const outsider = await login('Arti', 'artist');

const artist = (name) => Employee.create({ name, department: 'Artist', role: 'artist' });
const [nihala, sana, riya] = await Promise.all([artist('Nihala'), artist('Sana'), artist('Riya')]);
const staff = (e, roleType) => ({ employeeId: e._id, artistName: e.name, roleType });

const at = (day, h = 10) => new Date(`${day}T${String(h).padStart(2, '0')}:00:00+05:30`);
const work = (customerName, day, assignedStaff, extra = {}) =>
  Booking.create({ customerName, service: 'Bridal Makeup', district: 'Kozhikode', bookingDate: at(day), serviceStart: at(day), serviceEnd: at(day, 14), selectedDates: [day], status: 'completed', totalPrice: 30000, assignedStaff, ...extra });
const review = (b, fields) => Review.create({ token: crypto.randomBytes(12).toString('hex'), booking: b?._id ?? null, bookingNumber: b?.bookingNumber ?? '', brideName: b?.customerName ?? '', weddingDate: b?.bookingDate ?? null, sentAt: at('2026-11-02', 9), ...fields });

// B1 — Nihala (lead) + Sana: a complaint, 2 stars, the hair came loose
const b1 = await work('Amina K', '2026-11-01', [staff(nihala, 'lead'), staff(sana, 'assistant')]);
await review(b1, { status: 'submitted', submittedAt: at('2026-11-02', 11), overall: 2, makeup: 4, hair: 2, saree: 3, nps: 4, complaint: true, couldBeBetter: 'The hair came loose before the reception', likedMost: 'The base was flawless', teamMembers: [{ name: 'Nihala', role: 'Lead Artist', employeeId: nihala._id }, { name: 'Sana', role: 'Assistant', employeeId: sana._id }] });
// B2 — Nihala alone: 5 stars, testimonial with consent (its photos come through the shoot that covered it)
const b2 = await work('Fathima R', '2026-11-05', [staff(nihala, 'lead')]);
await review(b2, { status: 'submitted', submittedAt: at('2026-11-06', 11), overall: 5, makeup: 5, hair: 5, nps: 10, testimonial: 'Best day ever', marketingConsent: true, teamMembers: [{ name: 'Nihala', role: 'Lead Artist', employeeId: nihala._id }] });
// B3 — Riya: the review was sent this morning, not answered yet
const b3 = await work('Hiba S', '2026-11-08', [staff(riya, 'lead')]);
await review(b3, { status: 'pending' });
// B4 — Sana: no review sent yet
const b4 = await work('Nisha P', '2026-11-09', [staff(sana, 'lead')]);
// an old review kept with no booking and only names
await review(null, { status: 'submitted', submittedAt: at('2026-11-03', 11), weddingDate: at('2026-11-03'), overall: 3, artistNames: ['Old Artist'], artistName: 'Old Artist' });

const shoot = await Shoot.create({ title: 'Fathima wedding shoot', brand: 'main', category: 'Bridal Makeup', shootDate: '2026-11-05', bookingId: b2._id });
const add = async (body) => {
  const r = await call('POST', '/socials/assets', boss, { url: `https://www.dropbox.com/s/${Math.random().toString(36).slice(2)}/x.mp4`, kind: 'reel', media: 'video', ...body });
  assert.equal(r.status, 201, r.text);
  return r.body;
};

let a1, a2, a3, a4, a5, a6;
console.log('\n— each gallery item carries its work and the client\'s review —');
await check('footage of a work (its booking): booking, client, day, artists, and the complaint in the client\'s words', async () => {
  a1 = await Asset.create({ title: 'Amina — raw footage', url: 'https://www.dropbox.com/s/a1/x.mp4', media: 'video', kind: 'bts', bookingId: b1._id, workDay: '2026-11-01' });
  a2 = await add({ title: 'Fathima — reel', shootId: String(shoot._id) });
  a3 = await add({ title: 'Hiba — portrait', media: 'image', kind: 'still', bookingId: String(b3._id) });
  a4 = await add({ title: 'Nisha — reel', bookingId: String(b4._id) });
  a5 = await add({ title: 'Logo sheet', kind: 'design', media: 'design' });
  const l = await list(boss);
  const one = l.items.find((x) => x.title === 'Amina — raw footage');
  assert.equal(one.bookingId, String(b1._id));
  assert.deepEqual([one.work.bookingNumber, one.work.client, one.work.eventDay, one.work.workDay, one.work.place], [b1.bookingNumber, 'Amina K', '2026-11-01', '2026-11-01', 'Kozhikode']);
  assert.deepEqual(one.work.artists.map((a) => [a.name, a.role]), [['Nihala', 'Lead Artist'], ['Sana', 'Assistant']]);
  assert.deepEqual([one.work.review.status, one.work.review.score, one.work.review.band, one.work.review.complaint, one.work.review.needsAttention], ['submitted', 2, 'low', true, true]);
  assert.equal(one.work.review.couldBeBetter, 'The hair came loose before the reception');
  assert.ok(!JSON.stringify(l).includes('"token"'), 'the review form\'s private link never leaves the server');
});
await check('through the shoot that covered the booking; a picked booking; a review still waiting; none sent; no work at all', async () => {
  const l = await list(boss);
  const by = (t) => l.items.find((x) => x.title === t);
  assert.equal(by('Fathima — reel').work.client, 'Fathima R');
  assert.deepEqual([by('Fathima — reel').work.review.band, by('Fathima — reel').work.review.testimonial, by('Fathima — reel').work.review.marketingConsent], ['great', 'Best day ever', true]);
  assert.equal(by('Fathima — reel').bookingId, null, 'its own booking is not set — the work comes from the shoot');
  assert.deepEqual([by('Hiba — portrait').work.review.status, by('Hiba — portrait').work.review.score], ['pending', undefined]);
  assert.equal(by('Nisha — reel').work.review, null, 'no review sent yet');
  assert.deepEqual(by('Nisha — reel').work.artists.map((a) => a.name), ['Sana']);
  assert.equal(by('Logo sheet').work, null);
});
await check('a booking of its own wins over its shoot\'s; opening one item gives its work too', async () => {
  a6 = await add({ title: 'Amina — still from the Fathima shoot', media: 'image', kind: 'still', shootId: String(shoot._id), bookingId: String(b1._id) });
  assert.equal(a6.work.client, 'Amina K', 'the reply to the upload already carries it');
  const one = await call('GET', `/socials/assets/${a2.id}`, boss);
  assert.equal(one.status, 200);
  assert.equal(one.body.work.client, 'Fathima R');
});
await check('a booking that does not exist is refused; taking the booking off leaves the item with no work', async () => {
  const bad = await call('POST', '/socials/assets', boss, { title: 'Wrong booking', url: 'https://d.test/x', bookingId: 'nope' });
  assert.equal(bad.status, 400);
  const gone = await call('POST', '/socials/assets', boss, { title: 'Gone booking', url: 'https://d.test/x', bookingId: String(new mongoose.Types.ObjectId()) });
  assert.equal(gone.status, 400);
  assert.match(gone.body.message, /no longer exists/);
  const off = await call('PUT', `/socials/assets/${a4.id}`, boss, { bookingId: null });
  assert.equal(off.status, 200, off.text);
  assert.equal(off.body.work, null);
  const back = await call('PUT', `/socials/assets/${a4.id}`, boss, { bookingId: String(b4._id) });
  assert.equal(back.body.work.client, 'Nisha P');
});

console.log('\n— filters: the artist on the work, the client\'s review —');
await check('the numbers: items per artist (every artist on the work), items per kind of review', async () => {
  const l = await list(boss);
  const count = Object.fromEntries(l.facets.artists.map((a) => [a.name, a.count]));
  assert.deepEqual(count, { Nihala: 3, Sana: 3, Riya: 1 }, 'Nihala: Amina footage + still, Fathima reel · Sana: Amina ×2, Nisha');
  assert.equal(l.facets.artists.find((a) => a.name === 'Nihala').key, String(nihala._id));
  assert.deepEqual(l.facets.reviews, { great: 1, good: 0, low: 2, complaint: 2, waiting: 1 });
});
await check('an artist → the items of their works; with a review kind both must hold', async () => {
  assert.deepEqual(titles(await list(boss, { artist: String(nihala._id) })), ['Amina — raw footage', 'Amina — still from the Fathima shoot', 'Fathima — reel']);
  assert.deepEqual(titles(await list(boss, { artist: [String(riya._id), String(sana._id)] })), ['Amina — raw footage', 'Amina — still from the Fathima shoot', 'Hiba — portrait', 'Nisha — reel']);
  assert.deepEqual(titles(await list(boss, { artist: String(sana._id), review: 'complaint' })), ['Amina — raw footage', 'Amina — still from the Fathima shoot']);
});
await check('review kinds: complaints, waiting, great OR low', async () => {
  assert.deepEqual(titles(await list(boss, { review: 'waiting' })), ['Hiba — portrait']);
  assert.deepEqual(titles(await list(boss, { review: ['great', 'low'] })), ['Amina — raw footage', 'Amina — still from the Fathima shoot', 'Fathima — reel']);
  assert.equal((await list(boss, { review: 'good' })).total, 0);
});
await check('each filter is counted without itself: after picking Nihala, Sana still shows; the review numbers follow Nihala', async () => {
  const l = await list(boss, { artist: String(nihala._id) });
  assert.equal(l.facets.artists.find((a) => a.name === 'Sana').count, 3);
  assert.deepEqual(l.facets.reviews, { great: 1, good: 0, low: 2, complaint: 2, waiting: 0 });
  const picked = await list(boss, { artist: String(new mongoose.Types.ObjectId()) });
  assert.equal(picked.total, 0);
  assert.ok(picked.facets.artists.some((a) => a.count === 0), 'an artist asked for stays listed');
});
await check('works with the other filters and the search', async () => {
  assert.deepEqual(titles(await list(boss, { review: 'low', media: 'image' })), ['Amina — still from the Fathima shoot']);
  assert.deepEqual(titles(await list(boss, { artist: String(nihala._id), q: 'reel' })), ['Fathima — reel']);
});

console.log('\n— Artist Quality —');
const period = { from: '2026-11-01', to: '2026-11-30' };
const q = async (who, path = '/portfolio/quality', p = period) => call('GET', `${path}?${new URLSearchParams(p)}`, who);
await check('every artist, the ones needing a look first; each work\'s rating counts for all its artists', async () => {
  const r = await q(boss);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.artists.map((a) => a.name), ['Sana', 'Nihala', 'Old Artist', 'Riya']);
  const sanaRow = r.body.artists[0];
  assert.deepEqual([sanaRow.works, sanaRow.reviewed, sanaRow.avgScore, sanaRow.complaints, sanaRow.low, sanaRow.assets], [1, 1, 2, 1, 1, 2], 'B4 has no review — not counted');
  assert.equal(sanaRow.weakest.label, 'Hair');
  const nRow = r.body.artists[1];
  assert.deepEqual([nRow.works, nRow.reviewed, nRow.avgScore, nRow.complaints, nRow.great, nRow.nps, nRow.assets], [2, 2, 3.5, 1, 1, 0, 3]);
  assert.deepEqual([r.body.artists[3].reviewed, r.body.artists[3].waiting], [0, 1]);
  assert.deepEqual([r.body.totals.works, r.body.totals.reviewed, r.body.totals.waiting, r.body.totals.complaints, r.body.totals.avgScore], [4, 3, 1, 1, 3.3]);
  assert.ok(r.body.areas.some((a) => a.key === 'hair'));
});
await check('one artist: the works, the complaint first, each with its photos and videos and the client\'s words', async () => {
  const r = await q(boss, `/portfolio/quality/artist/${nihala._id}`);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.works.map((w) => w.client), ['Amina K', 'Fathima R']);
  assert.equal(r.body.works[0].review.couldBeBetter, 'The hair came loose before the reception');
  assert.deepEqual(r.body.works[0].items.map((i) => i.title).sort(), ['Amina — raw footage', 'Amina — still from the Fathima shoot']);
  assert.deepEqual(r.body.works[1].items.map((i) => i.title), ['Fathima — reel']);
  assert.equal(r.body.artist.name, 'Nihala');
});
await check('a name kept without an id still opens; an artist with nothing in the days → 404', async () => {
  const old = await q(boss, `/portfolio/quality/artist/${encodeURIComponent('n:old artist')}`);
  assert.equal(old.status, 200, old.text);
  assert.equal(old.body.works.length, 1);
  const none = await q(boss, `/portfolio/quality/artist/${new mongoose.Types.ObjectId()}`);
  assert.equal(none.status, 404);
});
await check('the days: the works of those event days only; days that make no sense are refused', async () => {
  const early = await q(boss, '/portfolio/quality', { from: '2026-11-01', to: '2026-11-04' });
  // only Amina's work and the old review: Nihala and Sana tie (the same complaint) — by name
  assert.deepEqual(early.body.artists.map((a) => a.name), ['Nihala', 'Sana', 'Old Artist']);
  assert.equal((await q(boss, '/portfolio/quality', { from: '2026-11-30', to: '2026-11-01' })).status, 400);
  assert.equal((await q(boss, '/portfolio/quality', { from: 'yesterday', to: '2026-11-01' })).status, 400);
});
await check('only the Marketing team opens it', async () => {
  const r = await q(outsider);
  assert.equal(r.status, 403);
});

server.close();
await mongoose.disconnect();
console.log(`\n${pass} passed, ${failures.length} failed${failures.length ? `: ${failures.join(' | ')}` : ''}`);
process.exit(failures.length ? 1 : 0);
