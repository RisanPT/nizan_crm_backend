// End-to-end check of the marketing SAVED and SCHEDULED reports (/api/marketing/reports, services/marketingReportScheduler.js): the
// spec's schedules exist; only a manager switches them; a due schedule saves one report for the period that just ended and tells the
// managers once, however often it is checked; a member sees what they saved plus the scheduled ones, a manager everything.
// Against a THROWAWAY local MongoDB (127.0.0.1:27099; refuses anything else, drops its database first):
//   node tests/e2e/marketing-reports.e2e.mjs
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
// NOTHING leaves this machine: the code under test loads the real .env (dotenv does not override a variable already set, even to '').
for (const k of ['NODEMAILER_EMAIL', 'NODEMAILER_PASS', 'SMTP_HOST', 'MSG91_AUTHKEY', 'SMS_PROVIDER', 'TEAMN_CHAT_KEY', 'ORS_API_KEY', 'GEMINI_API_KEY', 'CLOUDFLARE_API_TOKEN', 'HF_TOKEN', 'POLLEN_KEY', 'REVIEW_AUTO_SEND_FROM', 'TIMEBOX_API_KEY', 'TIMEBOX_API_URL', 'CLOUDINARY_URL', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']) {
  process.env[k] = '';
}
await mongoose.connect('mongodb://127.0.0.1:27099/marketing_reports_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
await mongoose.connection.dropDatabase();

const root = new URL('../../', import.meta.url);
for (const f of readdirSync(new URL('models/', root))) await import(new URL(`models/${f}`, root));
const imp = (p) => import(new URL(p, root)).then((m) => m.default ?? m);
const User = await imp('models/User.js');
const Role = await imp('models/Role.js');
const Notification = await imp('models/Notification.js');
const Schedule = await imp('models/MarketingReportSchedule.js');
const Saved = await imp('models/MarketingSavedReport.js');
const { runDueReports } = await import(new URL('services/marketingReportScheduler.js', root));
const { sanitizeErrorResponses, errorHandler } = await import(new URL('middleware/errorMiddleware.js', root));
await import(new URL('utils/asyncErrors.js', root));
await Saved.init();

const app = express();
app.use(express.json());
app.use(sanitizeErrorResponses);
app.use('/api/marketing/reports', await imp('routes/marketingReportsRoutes.js'));
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/api/marketing/reports`;
const api = async (method, path, token, body) => {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
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

let n = 0;
const login = async (name, role) => {
  n += 1;
  const user = await User.create({ name, email: `${name}${n}@e2e.test`, password: 'secret123', role });
  return { user, id: String(user._id), token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
};
await Role.updateOne({ key: 'marketing_staff' }, { $setOnInsert: { key: 'marketing_staff', label: 'Marketing staff', permissions: ['marketing'] } }, { upsert: true });
await Role.updateOne({ key: 'marketing_manager' }, { $setOnInsert: { key: 'marketing_manager', label: 'Marketing manager', permissions: ['marketing'] } }, { upsert: true });
const manager = await login('Salmaan', 'marketing_manager');
const member = await login('Saeeda', 'marketing_staff');
const other = await login('Bina', 'marketing_staff');
const outsider = await login('Sam', 'sales');

console.log('Schedules');
await check('the spec\'s nine schedules exist; everyone in Marketing sees them, only a manager can change them', async () => {
  const r = await api('GET', '/schedules?module=team', member.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.canManage, false);
  assert.deepEqual(r.body.schedules.map((s) => [s.label, s.when, s.enabled]), [
    ['Campaign Summary', 'Every Friday, 6:00 PM', false],
    ['Monthly Performance', '1st of every month, 9:00 AM', true],
    ['Weekly Team Report', 'Every Monday, 10:00 AM', true],
  ]);
  assert.equal((await api('GET', '/schedules', manager.token)).body.schedules.length, 9);
  assert.equal((await api('PUT', '/schedules/team.weekly', member.token, { enabled: false })).status, 403);
  assert.equal((await api('GET', '/schedules', outsider.token)).status, 403, 'not Marketing');
  const changed = await api('PUT', '/schedules/team.campaign-summary', manager.token, { enabled: true, time: '17:30' });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.deepEqual([changed.body.enabled, changed.body.when, changed.body.updatedByName], [true, 'Every Friday, 5:30 PM', 'Salmaan']);
  assert.ok(changed.body.nextRunAt);
  assert.equal((await api('PUT', '/schedules/team.monthly', manager.token, { weekday: 3 })).status, 400, 'a monthly report has no weekday');
  assert.equal((await api('PUT', '/schedules/nope', manager.token, { enabled: true })).status, 404);
});

console.log('A scheduled run');
await check('Monday 10:00 IST: the weekly reports run once each, are saved for last week, and the manager is told once', async () => {
  const monday = new Date('2026-11-16T10:05:00+05:30');
  const first = await runDueReports(monday);
  assert.deepEqual(first.map((r) => r.key).sort(), ['campaigns.weekly', 'leads.weekly', 'team.weekly']);
  assert.ok(first.every((r) => r.period.from === '2026-11-09' && r.period.to === '2026-11-15'));
  const again = await runDueReports(new Date('2026-11-16T11:00:00+05:30'));
  assert.deepEqual(again, [], 'not twice for the same week');
  const notes = await Notification.find({ recipient: manager.user._id, type: 'marketing_report_ready' }).lean();
  assert.equal(notes.length, 3);
  assert.ok(notes.some((x) => x.title === 'Weekly Team Report is ready' && x.link.startsWith('/marketing/team?tab=reports&report=')));
  assert.equal(await Notification.countDocuments({ recipient: member.user._id, type: 'marketing_report_ready' }), 0, 'members are not told');
  // a switched-off schedule never runs; the 1st of the month runs the monthly ones
  const firstOfMonth = await runDueReports(new Date('2026-12-01T09:01:00+05:30'));
  assert.deepEqual(firstOfMonth.map((r) => r.key).sort(), ['campaigns.monthly', 'leads.monthly', 'team.monthly'], 'the quarterly and campaign-performance ones are off');
  assert.equal((await Schedule.findOne({ key: 'team.monthly' }).lean()).lastPeriodKey, 'm:2026-11');
});

await check('two scheduler runs at the same moment (two servers) still save one report and send one notice per schedule', async () => {
  const at = new Date('2026-11-23T10:01:00+05:30');
  const before = await Notification.countDocuments({ recipient: manager.user._id, type: 'marketing_report_ready' });
  await Promise.all([runDueReports(at), runDueReports(at), runDueReports(at)]);
  assert.equal(await Saved.countDocuments({ scheduleKey: 'team.weekly', from: '2026-11-16' }), 1);
  assert.equal(await Notification.countDocuments({ recipient: manager.user._id, type: 'marketing_report_ready' }), before + 3, 'one per weekly schedule');
});

console.log('Saved reports');
await check('a member saves a report; sees their own and the scheduled ones, not a colleague\'s; a manager sees all', async () => {
  const mine = await api('POST', '/saved', member.token, { module: 'leads', kind: 'source', name: 'Source report', from: '2026-11-01', to: '2026-11-15', brand: 'kerala' });
  assert.equal(mine.status, 201, JSON.stringify(mine.body));
  assert.deepEqual([mine.body.name, mine.body.brand, mine.body.mine, mine.body.scheduled], ['Source report', 'kerala', true, false]);
  await api('POST', '/saved', other.token, { module: 'leads', kind: 'campaign', from: '2026-11-01', to: '2026-11-15' });
  const seen = (await api('GET', '/saved?module=leads', member.token)).body.reports;
  assert.deepEqual(seen.map((r) => r.createdByName).sort(), ['Saeeda', 'Scheduled', 'Scheduled', 'Scheduled'], 'own + the three scheduled lead reports');
  const all = (await api('GET', '/saved?module=leads', manager.token)).body.reports;
  assert.equal(all.length, 5);
  assert.equal((await api('POST', '/saved', member.token, { module: 'leads', kind: 'x', from: '2026-11-09', to: '2026-11-01' })).status, 400);
  // the same report made again is the same saved report, back at the top — not a second one (above one made after it the first time)
  await new Promise((r) => setTimeout(r, 15));
  const later = await api('POST', '/saved', member.token, { module: 'leads', kind: 'team', name: 'Team report', from: '2026-11-01', to: '2026-11-15' });
  await new Promise((r) => setTimeout(r, 15));
  const again = await api('POST', '/saved', member.token, { module: 'leads', kind: 'source', name: 'Source report (again)', from: '2026-11-01', to: '2026-11-15', brand: 'kerala' });
  assert.equal(again.body.id, mine.body.id);
  assert.equal(again.body.name, 'Source report (again)');
  const afterAgain = (await api('GET', '/saved?module=leads', member.token)).body.reports;
  assert.equal(afterAgain.filter((x) => x.kind === 'source').length, 1);
  assert.equal(afterAgain[0].id, mine.body.id, 'made again: first in the list');
  assert.ok(new Date(afterAgain[0].createdAt) > new Date(mine.body.createdAt), 'shows when it was last made');
  // another brand, or another person, is another report
  const otherBrand = await api('POST', '/saved', member.token, { module: 'leads', kind: 'source', from: '2026-11-01', to: '2026-11-15', brand: 'main' });
  assert.notEqual(otherBrand.body.id, mine.body.id);
  await api('DELETE', `/saved/${otherBrand.body.id}`, member.token);
  await api('DELETE', `/saved/${later.body.id}`, member.token);
  // removing: your own yes, a colleague's no, a manager any
  const theirs = all.find((r) => r.createdByName === 'Bina');
  assert.equal((await api('DELETE', `/saved/${theirs.id}`, member.token)).status, 403);
  assert.equal((await api('DELETE', `/saved/${mine.body.id}`, member.token)).status, 200);
  assert.equal((await api('DELETE', `/saved/${theirs.id}`, manager.token)).status, 200);
});

server.close();
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
