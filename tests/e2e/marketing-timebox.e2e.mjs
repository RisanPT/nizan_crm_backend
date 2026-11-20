// End-to-end check of the Marketing team's attendance from Timebox (/api/marketing/team: attendance, overview, timesheet): with Timebox
// live, a linked member's presence, check-in / out, hours, month (days present, working days, %) and day plan are Timebox's EXACTLY —
// the CRM's own record and a work log no longer count; members are linked through their login, or by a name only one employee has;
// unlinked members are named; Timebox refusing the key falls back to the CRM's records and says so in words; Timebox's pages are all read.
// TIMEBOX IS A LOCAL STAND-IN SERVER — no request leaves this machine.
// Against a THROWAWAY local MongoDB (127.0.0.1:27099; refuses anything else, drops its database first):
//   node tests/e2e/marketing-timebox.e2e.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { readdirSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
for (const k of ['NODEMAILER_EMAIL', 'NODEMAILER_PASS', 'SMTP_HOST', 'MSG91_AUTHKEY', 'SMS_PROVIDER', 'TEAMN_CHAT_KEY', 'ORS_API_KEY', 'GEMINI_API_KEY', 'CLOUDFLARE_API_TOKEN', 'HF_TOKEN', 'POLLEN_KEY', 'REVIEW_AUTO_SEND_FROM', 'CLOUDINARY_URL', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'TIMEBOX_API_HEADER']) {
  process.env[k] = '';
}

// ── a stand-in Timebox on this machine (it must be up before the code under test reads TIMEBOX_API_URL) ──
const KEY = 'e2e-timebox-key';
let refuseKey = false;
const tbCalls = [];
const IST = (d, hm) => `${d}T${hm}:00+05:30`;
const now = new Date();
const today = new Date(now.getTime() + 330 * 60000).toISOString().slice(0, 10);
const monthStart = `${today.slice(0, 7)}-01`;
const earlier = today === monthStart ? today : `${today.slice(0, 7)}-${String(Math.max(1, Number(today.slice(8)) - 1)).padStart(2, '0')}`;
const DATA = {
  attendance: [
    { id: 1, employee: { id: 101, name: 'Ashique' }, date: today, status: 'completed', login_time: IST(today, '09:12'), logout_time: IST(today, '18:05'), worked_minutes: 493, lunch_minutes: 40, logout_estimated: false },
    { id: 2, employee: { id: 103, name: 'Faies' }, date: today, status: 'active', login_time: IST(today, '10:00'), logout_time: null, worked_minutes: null },
    { id: 3, employee: { id: 104, name: 'Saeeda' }, date: today, status: 'completed', login_time: IST(today, '09:30'), logout_time: IST(today, '15:00'), worked_minutes: 300 },
    ...(earlier !== today ? [{ id: 4, employee: { id: 101, name: 'Ashique' }, date: earlier, status: 'completed', login_time: IST(earlier, '09:00'), logout_time: IST(earlier, '17:00'), worked_minutes: 420 }] : []),
    { id: 5, employee: { id: 999, name: 'Someone in Sales' }, date: today, status: 'completed', login_time: IST(today, '09:00'), logout_time: IST(today, '17:00'), worked_minutes: 480 },
  ],
  'attendance-summary': [
    { employee: { id: 101, name: 'Ashique' }, days_present: 13, expected_days: 16, attendance_percent: 81, hours_worked: 101.5, excused_leave_days: 0 },
    { employee: { id: 102, name: 'Shahala' }, days_present: 10, expected_days: 16, attendance_percent: 63, hours_worked: 77, excused_leave_days: 1 },
    { employee: { id: 103, name: 'Faies' }, days_present: 15, expected_days: 16, attendance_percent: 94, hours_worked: 120, excused_leave_days: 0 },
    { employee: { id: 104, name: 'Saeeda' }, days_present: 8, expected_days: 16, attendance_percent: 50, hours_worked: 40, excused_leave_days: 0 },
  ],
  timebox: [{ id: 1, employee: { id: 101, name: 'Ashique' }, date: today, items: { worklist: [{ slot: 1, content: 'Edit bridal reel', done: true }, { slot: 2, content: 'Colour grade', done: true }, { slot: 3, content: 'Thumbnail', done: false }] } }],
  employees: [],
};
const tb = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  tbCalls.push({ path: u.pathname, offset: u.searchParams.get('offset'), key: req.headers['x-api-key'] });
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (refuseKey || req.headers['x-api-key'] !== KEY) return send(401, { ok: false, error: 'bad key' });
  const resource = u.pathname.replace(/^\/api\//, '');
  const rows = DATA[resource];
  if (!rows) return send(404, { ok: false, error: 'no such resource' });
  const offset = Number(u.searchParams.get('offset') || 0);
  const page = rows.slice(offset, offset + 2); // two a page: every page must be read
  send(200, { ok: true, resource, count: page.length, has_more: offset + 2 < rows.length, next_offset: offset + 2, data: page });
});
tb.listen(0, '127.0.0.1');
await new Promise((r) => tb.once('listening', r));
process.env.TIMEBOX_API_URL = `http://127.0.0.1:${tb.address().port}/api`;
process.env.TIMEBOX_API_KEY = KEY;

await mongoose.connect('mongodb://127.0.0.1:27099/marketing_timebox_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
await mongoose.connection.dropDatabase();

const root = new URL('../../', import.meta.url);
for (const f of readdirSync(new URL('models/', root))) await import(new URL(`models/${f}`, root));
const imp = (p) => import(new URL(p, root)).then((m) => m.default ?? m);
const User = await imp('models/User.js');
const Employee = await imp('models/Employee.js');
const Attendance = await imp('models/Attendance.js');
const MarketingActivity = await imp('models/MarketingActivity.js');
const E = await import(new URL('models/MarketingEod.js', root));
const { ensureDefaultRoles } = await import(new URL('controllers/roleController.js', root));
const { sanitizeErrorResponses, errorHandler } = await import(new URL('middleware/errorMiddleware.js', root));
const { _resetMarketingTimeboxCache } = await import(new URL('services/marketingTimebox.js', root));
const { timeboxMode } = await import(new URL('services/timeboxClient.js', root));
await import(new URL('utils/asyncErrors.js', root));
await ensureDefaultRoles();
assert.equal(timeboxMode(), 'live', 'the stand-in Timebox is what the client talks to');

const app = express();
app.use(express.json());
app.use(sanitizeErrorResponses);
app.use('/api/marketing/team', await imp('routes/marketingTeamRoutes.js'));
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/api/marketing`;
const get = async (path, token) => {
  const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = {};
  }
  return { status: res.status, body, text };
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

// ── the team ─────────────────────────────────────────────────────────────────
const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
await E.MarketingCalendarSetting.create({ weeklyOff: (dow + 3) % 7, standardHours: 8, editWindowDays: 2 });
const role = await E.MarketingRole.create({ name: 'Content Producer' });
let n = 0;
const login = async (name, roleKey, tbId) => {
  n += 1;
  const emp = await Employee.create({ name, department: 'Marketing', timeboxEmployeeId: tbId ?? null });
  const user = await User.create({ name, email: `${name.toLowerCase()}${n}@e2e.test`, password: 'secret123', role: roleKey, employeeId: emp._id });
  return { user, emp, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
};
const member = async (name, userId) => {
  const m = await E.MarketingTeamMember.create({ userId: userId ?? null, name, shortName: name, activeFrom: new Date(`${monthStart}T00:00:00Z`) });
  await E.MarketingMemberRole.create({ memberId: m._id, roleId: role._id, fromMonth: '2026-01' });
  return m;
};
const boss = await login('Boss', 'marketing_admin', null);
const ashique = await login('Ashique', 'marketing_admin', 101);
const shahala = await login('Shahala', 'marketing_admin', 102);
const faies = await login('Faies', 'marketing_admin', 103);
const intern = await login('Intern', 'marketing_admin', null); // their employee has no Timebox id
await Employee.create({ name: 'Saeeda', department: 'Marketing', timeboxEmployeeId: 104 }); // no login: found by the one employee with her name
await Employee.create({ name: 'Shahada', department: 'Marketing', timeboxEmployeeId: 105 });
await Employee.create({ name: 'shahada', department: 'Sales', timeboxEmployeeId: 106 }); // two with that name: not guessed
const M = {
  ashique: await member('Ashique', ashique.user._id),
  shahala: await member('Shahala', shahala.user._id),
  faies: await member('Faies', faies.user._id),
  saeeda: await member('Saeeda'),
  shahada: await member('Shahada'),
  intern: await member('Intern', intern.user._id),
};
// what the CRM says, which Timebox must override for a linked member: an 8:00–20:00 "Present" for Ashique, and a work log for Shahala
await Attendance.create({ employeeId: ashique.emp._id, date: new Date(`${today}T00:00:00+05:30`), status: 'Present', checkInTime: new Date(`${today}T08:00:00+05:30`), checkOutTime: new Date(`${today}T20:00:00+05:30`) });
await MarketingActivity.create({ memberId: M.shahala._id, entryDate: today, workedOn: 'Captions for the week', timeSpentMinutes: 60, loggedAt: new Date() });

const row = (body, m) => body.rows.find((r) => r.memberId === String(m._id));

console.log('Marketing attendance from Timebox');

await check('the Attendance tab: who is in, when, and Timebox\'s hours — exactly; a log or a CRM record does not make anyone present', async () => {
  const r = await get(`/team/attendance?date=${today}`, boss.token);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual({ ...r.body.timebox, unlinked: [...r.body.timebox.unlinked].sort() }, { mode: 'live', ok: true, problem: '', linked: 4, unlinked: ['Intern', 'Shahada'] }, JSON.stringify(r.body.timebox));
  const a = row(r.body, M.ashique);
  assert.deepEqual([a.state, a.status, a.hours, a.source, a.timeboxLink], ['Active', 'Out', 8.2, 'timebox', 'login']);
  assert.equal(new Date(a.checkIn).toISOString(), new Date(IST(today, '09:12')).toISOString(), 'Timebox\'s 9:12, not the CRM\'s 8:00');
  const s = row(r.body, M.shahala);
  assert.deepEqual([s.state, s.status, s.source], ['Not in yet', 'Not punched in', 'timebox'], 'her work log does not make her present');
  const f = row(r.body, M.faies);
  assert.deepEqual([f.state, f.status, f.hours, f.stillIn], ['Active', 'In', null, true]);
  const sa = row(r.body, M.saeeda);
  assert.deepEqual([sa.state, sa.hours, sa.timeboxLink], ['Active', 5, 'name']);
  assert.deepEqual([row(r.body, M.shahada).source, row(r.body, M.shahada).timeboxLink], ['', ''], 'two employees share the name: not linked');
  assert.deepEqual(r.body.summary, { present: 3, onShoot: 0, wfh: 0, onLeave: 0, absent: 3 });
});

await check('the month is Timebox\'s own count (days present, working days, %); the day\'s Timebox plan shows', async () => {
  const r = await get(`/team/attendance?date=${today}`, boss.token);
  const a = row(r.body, M.ashique);
  assert.deepEqual([a.daysAttended, a.daysExpected, a.monthRate, a.monthSource], [13, 16, 81, 'timebox']);
  assert.deepEqual(row(r.body, M.shahala).monthRate, 63);
  assert.deepEqual(a.plan, { total: 3, done: 2 });
  assert.equal(row(r.body, M.faies).plan, null, 'no plan written in Timebox today');
  assert.equal(row(r.body, M.intern).monthSource, '', 'not linked: no Timebox month');
});

await check('every page Timebox gives is read, with the key, and only from the stand-in on this machine', async () => {
  assert.ok(tbCalls.some((c) => c.path === '/api/attendance' && c.offset === '2'), 'the second page was asked for');
  assert.ok(tbCalls.every((c) => c.key === KEY));
});

await check('the Overview\'s "who is in" counts the same way', async () => {
  const r = await get(`/team/overview?from=${today}&to=${today}&brand=all`, boss.token);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.attendance.present, 3);
  assert.equal(r.body.attendance.timebox.ok, true);
});

await check('the Timesheet shows Timebox\'s hours beside the hours logged (none for someone not linked)', async () => {
  const r = await get(`/team/timesheet?from=${monthStart}&to=${today}&brand=all`, boss.token);
  assert.equal(r.status, 200, r.text);
  const a = row(r.body, M.ashique);
  assert.equal(a.timeboxMinutes, earlier !== today ? 493 + 420 : 493);
  assert.equal(row(r.body, M.shahala).timeboxMinutes, 0, 'linked, no punches: 0');
  assert.equal(row(r.body, M.shahada).timeboxMinutes, null, 'not linked: no figure, not 0');
  assert.equal(r.body.timeboxTotalMinutes, (earlier !== today ? 913 : 493) + 300);
  assert.equal(row(r.body, M.shahala).minutes, 60, 'her logged hour is still her logged hour');
});

await check('Timebox refusing the key: the CRM\'s records, labelled, and the reason in words — never made-up figures', async () => {
  refuseKey = true;
  _resetMarketingTimeboxCache();
  const r = await get(`/team/attendance?date=${today}`, boss.token);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.timebox.ok, false);
  assert.match(r.body.timebox.problem, /TIMEBOX_API_KEY/);
  const a = row(r.body, M.ashique);
  assert.deepEqual([a.source, a.monthSource], ['crm', '']);
  assert.equal(new Date(a.checkIn).toISOString(), new Date(`${today}T08:00:00+05:30`).toISOString());
  refuseKey = false;
  _resetMarketingTimeboxCache();
});

await check('a member sees only their own row, still from Timebox', async () => {
  const r = await get(`/team/attendance?date=${today}`, shahala.token);
  assert.equal(r.status, 200, r.text);
  assert.ok(r.body.rows.length >= 1);
  assert.equal(row(r.body, M.shahala).source, 'timebox');
});

server.close();
tb.close();
await mongoose.disconnect();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
