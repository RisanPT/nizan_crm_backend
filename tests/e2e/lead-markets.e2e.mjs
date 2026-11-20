// End-to-end check of the Country → City list and the marketing details on a lead — against a THROWAWAY local MongoDB (needs a mongod on
// 127.0.0.1:27099; refuses to run against anything else and drops its own database first):
//
//   mongod --port 27099 --bind_ip 127.0.0.1 --dbpath /tmp/lead-e2e --fork --logpath /tmp/lead-e2e/log
//   node tests/e2e/lead-markets.e2e.mjs
//
// The method: the list seeds itself once (even when asked five times at once) → managers change it, everybody else reads it → a lead is
// placed in a country and city and carries a WhatsApp number, e-mail, budget, language, referral and creative → every wrong input is refused
// and nothing is half-saved → an older app build that sends none of the new keys changes nothing → renames reach the leads → what is in use
// cannot be removed.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
// NOTHING leaves this machine: the code under test loads the real .env (dotenv does not override a variable that is already set, even
// to ''), so every outbound service's key is blanked first — no booking e-mail, SMS, WhatsApp, maps or AI call reaches anybody.
for (const k of ['NODEMAILER_EMAIL', 'NODEMAILER_PASS', 'SMTP_HOST', 'MSG91_AUTHKEY', 'SMS_PROVIDER', 'TEAMN_CHAT_KEY', 'ORS_API_KEY', 'GEMINI_API_KEY', 'CLOUDFLARE_API_TOKEN', 'HF_TOKEN', 'POLLEN_KEY', 'REVIEW_AUTO_SEND_FROM', 'TIMEBOX_API_KEY', 'TIMEBOX_API_URL', 'CLOUDINARY_URL', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']) {
  process.env[k] = '';
}
await mongoose.connect('mongodb://127.0.0.1:27099/lead_markets_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
assert.equal(mongoose.connection.name, 'lead_markets_e2e', 'SAFETY: not our own database');
await mongoose.connection.dropDatabase();

const root = new URL('../../', import.meta.url);
for (const f of readdirSync(new URL('models/', root))) await import(new URL(`models/${f}`, root));
const imp = (p) => import(new URL(p, root)).then((m) => m.default ?? m);
const User = await imp('models/User.js');
const Employee = await imp('models/Employee.js');
const Lead = await imp('models/Lead.js');
const Country = await imp('models/Country.js');
const City = await imp('models/City.js');
const { ensureDefaultRoles } = await import(new URL('controllers/roleController.js', root));
const { sanitizeErrorResponses, errorHandler } = await import(new URL('middleware/errorMiddleware.js', root));
await import(new URL('utils/asyncErrors.js', root));
await ensureDefaultRoles();
await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));

const app = express();
app.use(express.json());
app.use(sanitizeErrorResponses);
app.use('/api/countries', await imp('routes/countryRoutes.js'));
app.use('/api/leads', await imp('routes/leadRoutes.js'));
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/api`;

const call = async (method, path, who, body) => {
  const res = await fetch(`${base}${path}`, { method, headers: { ...(who ? { authorization: `Bearer ${who.token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
};

let pass = 0;
const failures = [];
const check = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  ✔ ${name}`); } catch (e) { failures.push(name); console.log(`  ✖ ${name}\n      ${String(e.message).split('\n').slice(0, 4).join('\n      ')}`); }
};

let n = 0;
const login = async (key, role) => {
  n += 1;
  const emp = await Employee.create({ name: key, department: 'Marketing' });
  const user = await User.create({ name: key, email: `${key}${n}@e2e.test`, password: 'secret123', role, employeeId: emp._id });
  return { id: String(user._id), name: key, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
};
const admin = await login('admin', 'admin');
const manager = await login('manager', 'manager');
const sales = await login('sales', 'sales');
const ceo = await login('ceo', 'ceo');

const byName = (list, name) => list.find((x) => x.name === name);
let phoneSeq = 9000000000;
const phone = () => String((phoneSeq += 1));
const newLead = (extra = {}) => ({ name: 'Bride', phone: phone(), source: 'Instagram', ...extra });

console.log('The list');
let india;
let uae;
let malaysia;
await check('asked five times at once while empty, it seeds exactly once: 3 countries, 12 cities', async () => {
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => call('GET', '/countries', sales)));
  for (const r of rs) assert.equal(r.status, 200, r.text);
  assert.equal(await Country.countDocuments({}), 3);
  assert.equal(await City.countDocuments({}), 12);
  const list = (await call('GET', '/countries', sales)).body.countries;
  assert.deepEqual(list.map((c) => c.name), ['India', 'Malaysia', 'UAE']);
  india = byName(list, 'India');
  uae = byName(list, 'UAE');
  malaysia = byName(list, 'Malaysia');
  assert.equal(uae.currency, 'AED');
  assert.equal(uae.dialCode, '+971');
  assert.deepEqual(uae.cities.map((c) => c.name), ['Abu Dhabi', 'Dubai', 'Sharjah']);
  assert.ok(india.cities.some((c) => c.name === 'Calicut' && c.state === 'Kerala'));
});
await check('the list says who may change it', async () => {
  assert.equal((await call('GET', '/countries', sales)).body.canManage, false);
  assert.equal((await call('GET', '/countries', ceo)).body.canManage, false);
  assert.equal((await call('GET', '/countries', manager)).body.canManage, true);
  assert.equal((await call('GET', '/countries', admin)).body.canManage, true);
});
await check('an anonymous caller gets nothing', async () => {
  assert.equal((await call('GET', '/countries', null)).status, 401);
});
await check('a salesperson reads but cannot add, rename or remove', async () => {
  assert.equal((await call('POST', '/countries', sales, { name: 'Oman' })).status, 403);
  assert.equal((await call('PUT', `/countries/${uae.id}`, sales, { name: 'Emirates' })).status, 403);
  assert.equal((await call('DELETE', `/countries/${uae.id}`, sales)).status, 403);
  assert.equal((await call('POST', `/countries/${uae.id}/cities`, sales, { name: 'Ajman' })).status, 403);
  assert.equal((await call('PUT', `/countries/cities/${uae.cities[0].id}`, sales, { name: 'X1' })).status, 403);
  assert.equal((await call('DELETE', `/countries/cities/${uae.cities[0].id}`, sales)).status, 403);
  assert.equal(await Country.countDocuments({}), 3);
});
await check('the CEO reads the list', async () => {
  assert.equal((await call('GET', '/countries', ceo)).status, 200);
});
await check('a manager adds a country and a city; the same name again (any capitals) is refused', async () => {
  const c = await call('POST', '/countries', manager, { name: ' Oman ', code: 'om', dialCode: '+968', currency: 'omr' });
  assert.equal(c.status, 201, c.text);
  assert.deepEqual([c.body.name, c.body.code, c.body.currency], ['Oman', 'OM', 'OMR']);
  const k = await call('POST', `/countries/${c.body.id}/cities`, manager, { name: 'Muscat' });
  assert.equal(k.status, 201, k.text);
  assert.equal((await call('POST', '/countries', admin, { name: 'oman' })).status, 409);
  assert.equal((await call('POST', `/countries/${c.body.id}/cities`, admin, { name: 'MUSCAT' })).status, 409);
  // the same city name in ANOTHER country is fine
  assert.equal((await call('POST', `/countries/${uae.id}/cities`, admin, { name: 'Muscat' })).status, 201);
});
await check('wrong forms are refused in plain words', async () => {
  for (const body of [{ name: '' }, { name: 'Qatar', code: '12' }, { name: 'Qatar', dialCode: '974' }, { name: 'Qatar', currency: 'RIYAL' }]) {
    const r = await call('POST', '/countries', admin, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.ok(r.body.message.length > 8);
  }
  assert.equal((await call('POST', `/countries/${uae.id}/cities`, admin, { name: 'A' })).status, 400);
  assert.equal((await call('POST', '/countries/not-an-id/cities', admin, { name: 'Ajman' })).status, 404);
  assert.equal((await call('PUT', '/countries/not-an-id', admin, { name: 'Zed' })).status, 404);
});

console.log('A lead placed in a country and city');
const dubai = () => byName(uae.cities, 'Dubai');
const mumbai = () => byName(india.cities, 'Mumbai');
let lead;
await check('a lead is placed; the names come from the list, never from the client', async () => {
  const r = await call('POST', '/leads', sales, newLead({
    countryId: uae.id, cityId: dubai().id, country: 'Atlantis', city: 'Nowhere',
    whatsapp: '+971 50 123 4567', email: ' bride@example.com ', budget: '1,20,000', language: 'Malayalam', referralPartner: 'Aysha  Weddings', creative: 'Reel #17',
  }));
  assert.equal(r.status, 201, r.text);
  lead = r.body;
  assert.deepEqual([lead.country, lead.city], ['UAE', 'Dubai']);
  assert.equal(String(lead.countryId), uae.id);
  assert.equal(String(lead.cityId), dubai().id);
  assert.equal(lead.whatsapp, '+971501234567');
  assert.equal(lead.email, 'bride@example.com');
  assert.equal(lead.budget, 120000);
  assert.equal(lead.budgetCurrency, 'AED', 'a budget with no currency takes the country\'s');
  assert.equal(lead.language, 'Malayalam');
  assert.equal(lead.referralPartner, 'Aysha Weddings');
  assert.equal(lead.creative, 'Reel #17');
});
await check('a city brings its own country when none is sent', async () => {
  const r = await call('POST', '/leads', sales, newLead({ cityId: mumbai().id }));
  assert.equal(r.status, 201, r.text);
  assert.deepEqual([r.body.country, r.body.city], ['India', 'Mumbai']);
  assert.equal(String(r.body.countryId), india.id);
});
await check('a country alone is fine: no city', async () => {
  const r = await call('POST', '/leads', sales, newLead({ countryId: malaysia.id }));
  assert.equal(r.status, 201, r.text);
  assert.deepEqual([r.body.country, r.body.city, r.body.cityId], ['Malaysia', '', null]);
});
await check('names sent without ids are ignored, on a new lead and on an edit', async () => {
  const r = await call('POST', '/leads', sales, newLead({ country: 'Atlantis', city: 'Nowhere' }));
  assert.equal(r.status, 201, r.text);
  assert.deepEqual([r.body.country, r.body.city, r.body.countryId, r.body.cityId], ['', '', null, null]);
  const placed = await call('POST', '/leads', sales, newLead({ cityId: mumbai().id }));
  const e = await call('PUT', `/leads/${placed.body._id}`, sales, { country: 'Atlantis', city: 'Nowhere', remarks: 'x' });
  assert.equal(e.status, 200, e.text);
  assert.deepEqual([e.body.country, e.body.city], ['India', 'Mumbai']);
});
await check('a budget sent with a country takes that country\'s currency, not the old one', async () => {
  const r = await call('POST', '/leads', sales, newLead({ countryId: uae.id, budget: 5000 }));
  assert.equal(r.body.budgetCurrency, 'AED');
  const e = await call('PUT', `/leads/${r.body._id}`, sales, { countryId: malaysia.id, budget: 7000 });
  assert.equal(e.status, 200, e.text);
  assert.deepEqual([e.body.budget, e.body.budgetCurrency], [7000, 'MYR']);
  // sent explicitly, the currency is the one sent
  const x = await call('PUT', `/leads/${r.body._id}`, sales, { budget: 9000, budgetCurrency: 'usd' });
  assert.deepEqual([x.body.budget, x.body.budgetCurrency], [9000, 'USD']);
});
await check('a lead with none of it still saves, as before', async () => {
  const r = await call('POST', '/leads', sales, newLead());
  assert.equal(r.status, 201, r.text);
  assert.deepEqual([r.body.country, r.body.city, r.body.whatsapp, r.body.budget, r.body.language, r.body.creative], ['', '', '', null, '', '']);
});
await check('every wrong input is refused and nothing is saved', async () => {
  const before = await Lead.countDocuments({});
  const wrong = [
    { cityId: mumbai().id, countryId: uae.id }, // a city outside the country
    { cityId: new mongoose.Types.ObjectId().toString() }, // not in the list
    { countryId: new mongoose.Types.ObjectId().toString() },
    { cityId: 'not-an-id' },
    { countryId: 'not-an-id' },
    { whatsapp: 'call me' },
    { whatsapp: '12345' },
    { email: 'bride@' },
    { budget: '-5' },
    { budget: 'a lot' },
    { budgetCurrency: 'dirham' },
    { language: 'x'.repeat(41) },
    { referralPartner: 'x'.repeat(81) },
    { creative: 'x'.repeat(121) },
  ];
  for (const w of wrong) {
    const r = await call('POST', '/leads', sales, newLead(w));
    assert.equal(r.status, 400, `${JSON.stringify(w)} → ${r.status} ${r.text}`);
    assert.ok(typeof r.body.message === 'string' && r.body.message.length > 8, JSON.stringify(w));
  }
  assert.equal(await Lead.countDocuments({}), before);
});

console.log('Editing it');
const snapshot = async (id) => {
  const l = await Lead.findById(id).lean();
  return { country: l.country, city: l.city, countryId: String(l.countryId ?? ''), cityId: String(l.cityId ?? ''), whatsapp: l.whatsapp, email: l.email, budget: l.budget, budgetCurrency: l.budgetCurrency, language: l.language, referralPartner: l.referralPartner, creative: l.creative };
};
await check('an older app build that sends none of the new keys changes nothing', async () => {
  const before = await snapshot(lead._id);
  const r = await call('PUT', `/leads/${lead._id}`, sales, { name: 'Bride Renamed', remarks: 'called' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(await snapshot(lead._id), before);
});
await check('a country alone, with a city in ANOTHER country, clears the city', async () => {
  const r = await call('PUT', `/leads/${lead._id}`, sales, { countryId: malaysia.id });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.body.country, r.body.city, r.body.cityId], ['Malaysia', '', null]);
});
await check('a country alone keeps the city when the city is in it', async () => {
  await call('PUT', `/leads/${lead._id}`, sales, { cityId: dubai().id });
  const r = await call('PUT', `/leads/${lead._id}`, sales, { countryId: uae.id });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.body.country, r.body.city], ['UAE', 'Dubai']);
});
await check('moving to another city moves the country with it', async () => {
  const r = await call('PUT', `/leads/${lead._id}`, sales, { cityId: mumbai().id });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.body.country, r.body.city], ['India', 'Mumbai']);
});
await check('a budget changed alone keeps the currency; cleared, it clears the currency too', async () => {
  const r = await call('PUT', `/leads/${lead._id}`, sales, { budget: 250000 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.budget, 250000);
  assert.equal(r.body.budgetCurrency, 'AED', 'the lead\'s currency is kept');
  const c = await call('PUT', `/leads/${lead._id}`, sales, { budget: '' });
  assert.equal(c.body.budget, null);
  assert.equal(c.body.budgetCurrency, '');
});
await check('empty values clear their fields', async () => {
  const r = await call('PUT', `/leads/${lead._id}`, sales, { countryId: '', cityId: null, whatsapp: '', language: '', referralPartner: '', creative: '' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(await snapshot(lead._id), { country: '', city: '', countryId: '', cityId: '', whatsapp: '', email: 'bride@example.com', budget: null, budgetCurrency: '', language: '', referralPartner: '', creative: '' });
});
await check('an old lead with a sloppy e-mail can still be saved; changing it to another bad one is refused', async () => {
  const old = await Lead.create({ name: 'Old', phone: phone(), email: 'sloppy-address' });
  assert.equal((await call('PUT', `/leads/${old._id}`, sales, { email: 'sloppy-address', remarks: 'ok' })).status, 200);
  assert.equal((await call('PUT', `/leads/${old._id}`, sales, { email: 'still sloppy' })).status, 400);
  assert.equal((await call('PUT', `/leads/${old._id}`, sales, { email: 'fixed@example.com' })).status, 200);
});
await check('a wrong edit is refused and the lead is left as it was', async () => {
  const before = await snapshot(lead._id);
  assert.equal((await call('PUT', `/leads/${lead._id}`, sales, { whatsapp: 'nope', language: 'Hindi' })).status, 400);
  assert.deepEqual(await snapshot(lead._id), before);
});

console.log('Renames, switching off, removing');
let placed;
await check('renaming a city or country reaches its leads, without touching their updatedAt', async () => {
  const r = await call('POST', '/leads', sales, newLead({ cityId: dubai().id }));
  placed = r.body;
  const stamp = (await Lead.findById(placed._id).lean()).updatedAt.getTime();
  await new Promise((s) => setTimeout(s, 15));
  assert.equal((await call('PUT', `/countries/cities/${dubai().id}`, manager, { name: 'Dubai City' })).status, 200);
  assert.equal((await call('PUT', `/countries/${uae.id}`, manager, { name: 'United Arab Emirates' })).status, 200);
  const l = await Lead.findById(placed._id).lean();
  assert.deepEqual([l.country, l.city], ['United Arab Emirates', 'Dubai City']);
  assert.equal(l.updatedAt.getTime(), stamp);
});
await check('a rename onto a name already there is refused', async () => {
  assert.equal((await call('PUT', `/countries/${uae.id}`, manager, { name: 'india' })).status, 409);
  assert.equal((await call('PUT', `/countries/cities/${dubai().id}`, manager, { name: 'sharjah' })).status, 409);
});
await check('what is in use cannot be removed', async () => {
  const c = await call('DELETE', `/countries/${uae.id}`, manager);
  assert.equal(c.status, 409);
  assert.match(c.body.message, /city|cities/);
  const k = await call('DELETE', `/countries/cities/${dubai().id}`, manager);
  assert.equal(k.status, 409);
  assert.match(k.body.message, /lead/);
});
await check('a city or country nobody uses can be removed', async () => {
  const sharjah = byName(uae.cities, 'Sharjah');
  assert.equal((await call('DELETE', `/countries/cities/${sharjah.id}`, manager)).status, 200);
  const empty = await call('POST', '/countries', manager, { name: 'Atlantis' });
  assert.equal((await call('DELETE', `/countries/${empty.body.id}`, manager)).status, 200);
  assert.equal(await Country.countDocuments({ name: 'Atlantis' }), 0);
});
await check('a city switched off leaves the list but stays on its leads; managers can still see it', async () => {
  const johor = byName(malaysia.cities, 'Johor');
  const r = await call('POST', '/leads', sales, newLead({ cityId: johor.id }));
  assert.equal((await call('PUT', `/countries/cities/${johor.id}`, manager, { status: 'inactive' })).status, 200);
  const active = (await call('GET', '/countries', sales)).body.countries;
  assert.ok(!byName(byName(active, 'Malaysia').cities, 'Johor'));
  // a salesperson cannot ask for the switched-off ones
  assert.ok(!byName(byName((await call('GET', '/countries?all=1', sales)).body.countries, 'Malaysia').cities, 'Johor'));
  const all = (await call('GET', '/countries?all=1', manager)).body.countries;
  const j = byName(byName(all, 'Malaysia').cities, 'Johor');
  assert.equal(j.status, 'inactive');
  assert.equal(j.leads, 1);
  assert.equal((await Lead.findById(r.body._id).lean()).city, 'Johor');
  // re-saving that lead (the form sends the same city back) still works
  assert.equal((await call('PUT', `/leads/${r.body._id}`, sales, { cityId: johor.id, remarks: 'again' })).status, 200);
  assert.equal((await call('PUT', `/countries/cities/${johor.id}`, manager, { status: 'sideways' })).status, 400);
});
await check('the lead counts per country and city are real', async () => {
  const all = (await call('GET', '/countries?all=1', admin)).body.countries;
  const c = all.find((x) => x.name === 'United Arab Emirates');
  assert.equal(c.leads, await Lead.countDocuments({ countryId: c.id }));
  assert.equal(byName(c.cities, 'Dubai City').leads, await Lead.countDocuments({ cityId: byName(c.cities, 'Dubai City').id }));
});

console.log('\nThe new lead fields the Marketing screens read');
await check('a lead can be Nurture (a quality of its own) and come from the Website; an unknown priority is refused', async () => {
  const r = await call('POST', '/leads', sales, newLead({ priority: 'Nurture', source: 'Website' }));
  assert.equal(r.status, 201, r.text);
  const saved = await Lead.findById(r.body._id).lean();
  assert.deepEqual([saved.priority, saved.source], ['Nurture', 'Website']);
  assert.notEqual((await call('POST', '/leads', sales, newLead({ priority: 'Lukewarm' }))).status, 201);
});
await check('a follow-up says how it is done — call, WhatsApp, visit, meeting or other; anything else is refused in plain words', async () => {
  const LeadActivity = await imp('models/LeadActivity.js');
  const lead = (await call('POST', '/leads', sales, newLead())).body;
  const when = new Date(Date.now() + 86400000).toISOString();
  const ok = await call('POST', `/leads/${lead._id}/activities`, sales, { type: 'followup', scheduledDate: when, channel: 'WhatsApp', remark: 'Send the album' });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(ok.body.channel, 'whatsapp');
  const bad = await call('POST', `/leads/${lead._id}/activities`, sales, { type: 'followup', scheduledDate: when, channel: 'pigeon' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.message, /call, whatsapp, visit, meeting, other/);
  const none = await call('POST', `/leads/${lead._id}/activities`, sales, { type: 'followup', scheduledDate: when });
  assert.equal(none.status, 201, 'the type is optional');
  assert.equal(none.body.channel, '');
  const changed = await call('PUT', `/leads/${lead._id}/activities/${none.body._id}`, sales, { channel: 'visit' });
  assert.equal(changed.status, 200, changed.text);
  assert.equal((await LeadActivity.findById(none.body._id).lean()).channel, 'visit');
  assert.equal((await call('PUT', `/leads/${lead._id}/activities/${none.body._id}`, sales, { channel: 'fax' })).status, 400);
});

console.log(`\n${pass} passed, ${failures.length} failed`);
server.close();
await mongoose.disconnect();
if (failures.length) {
  console.log(`FAILED:\n - ${failures.join('\n - ')}`);
  process.exit(1);
}
