// End-to-end check of the FINANCE REPORT (Artist Finance → Reports): CSV, Excel and PDF carry, on the SAME
// row as each expense, the work it belongs to — the artist's own pick, or placed by the time of the meal.
// Against a THROWAWAY local MongoDB (needs a mongod on 127.0.0.1:27099; refuses to run against
// anything else, and drops its database first):
//
//   mkdir -p /tmp/fr-e2e && mongod --port 27099 --bind_ip 127.0.0.1 --dbpath /tmp/fr-e2e --fork --logpath /tmp/fr-e2e/log
//   node tests/e2e/finance-report.e2e.mjs
//
// Not part of `node --test tests/*.test.js` (those are pure; this one needs a database).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import XLSX from 'xlsx';

process.env.JWT_SECRET = 'e2e-secret';
await mongoose.connect('mongodb://127.0.0.1:27099/finance_report_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
await mongoose.connection.dropDatabase();

const root = new URL('../../', import.meta.url);
for (const f of readdirSync(new URL('models/', root))) await import(new URL(`models/${f}`, root));
const imp = (p) => import(new URL(p, root)).then((m) => m.default ?? m);
const User = await imp('models/User.js');
const Employee = await imp('models/Employee.js');
const Booking = await imp('models/Booking.js');
const Trial = await imp('models/Trial.js');
const Expense = await imp('models/Expense.js');
const Collection = await imp('models/Collection.js');
const { sanitizeErrorResponses, errorHandler } = await import(new URL('middleware/errorMiddleware.js', root));

const app = express();
app.use(express.json());
app.use(sanitizeErrorResponses);
app.use('/api/reports', await imp('routes/reportRoutes.js'));
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/api`;

let pass = 0;
const failures = [];
const check = async (name, fn) => {
  try {
    await fn();
    pass += 1;
    console.log(`  ✔ ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  ✖ ${name}\n      ${String(e.message).split('\n').slice(0, 8).join('\n      ')}`);
  }
};

// ── people, works, entries ──────────────────────────────────────────────────
const emp = (name) => Employee.create({ name, type: 'in-house', artistRole: 'artist', phone: '9895000001', category: 'creative', department: 'Creative', role: 'Makeup Artist' });
const asha = await emp('Asha');
const beena = await emp('Beena');
const user = await User.create({ name: 'accounts', email: 'accounts@e2e.test', password: 'secret123', role: 'accounts' });
const token = jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET);
const get = (qs) => fetch(`${base}/reports/finance?${qs}`, { headers: { authorization: `Bearer ${token}` } });

const ist = (day, hhmm) => new Date(`${day}T${hhmm}:00+05:30`);
const staff = (e) => ({ employeeId: e._id, artistName: e.name, roleType: 'lead' });
const work = (num, client, day, from, to, e) =>
  Booking.create({ bookingNumber: num, customerName: client, service: 'Bridal', bookingDate: ist(day, '00:00'), serviceStart: ist(day, from), serviceEnd: ist(day, to), totalPrice: 50000, status: 'confirmed', address: 'Venue', assignedStaff: [staff(e)] });
const w1 = await work('BK-100', 'Aysha Rahman', '2026-11-12', '09:00', '13:00', asha);
const w2 = await work('BK-200', 'Sana Fathima', '2026-11-14', '09:00', '13:00', beena);
const w3 = await work('BK-300', 'Late Bride', '2026-11-12', '17:00', '20:00', asha); // a second work the same day
const trial = await Trial.create({ clientName: 'Trial Client', phone: '9895000002', trialDate: '2026-11-10' });

const log = (e, category, amount, day, hhmm, extra = {}) => Expense.create({ employeeId: e._id, category, amount, workType: 'bridal', status: 'verified', date: ist(day, hhmm), ...extra });
await Collection.create({ employeeId: asha._id, bookingId: w1._id, amount: 25000, date: ist('2026-11-12', '10:00'), status: 'verified', notes: 'advance' });
await Collection.create({ employeeId: asha._id, trialId: trial._id, amount: 1000, date: ist('2026-11-10', '10:00'), status: 'pending' });
await log(asha, 'fuel', 800, '2026-11-12', '07:00', { bookingId: w1._id, notes: 'petrol' });                         // tied by the artist
await log(asha, 'food', 250, '2026-11-12', '12:00', { meal: 'lunch', notes: 'team lunch' });                           // placed by the meal time
await log(beena, 'travel', 120, '2026-11-13', '08:00', { notes: '=HYPERLINK("http://evil")' });                       // no work that day
await log(beena, 'food', 300, '2026-11-14', '13:30', { meal: 'lunch', bookingId: w2._id, status: 'pending' });
await log(asha, 'stay', 1400, '2026-11-12', '22:00', { bookingId: w1._id, loggedAmount: 1517, approvalNote: 'meal limit' }); // approved for less
await log(asha, 'other', 99, '2026-11-12', '20:00', { workType: 'model_shoot' });
await log(asha, 'food', 410, '2026-11-12', '18:30', { meal: 'dinner', notes: 'dinner at the evening work' });         // two works that day → by the time
await log(asha, 'fuel', 5000, '2026-11-12', '06:00', { bookingId: w1._id, status: 'rejected' });

const Q = 'from=2026-11-01&to=2026-11-30';
const sheet = (buf, name = 'Finance Report') => {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  return XLSX.utils.sheet_to_json(wb.Sheets[name], { raw: true, defval: '' });
};
const rowFor = (rows, pred) => rows.find(pred);

// a small CSV reader (quoted fields, "" for a quote, newlines inside quotes) → records with numbers as numbers
const csvRows = async (qs) => {
  const text = await (await get(qs)).text();
  const table = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); table.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); table.push(row); }
  const [head, ...body] = table;
  return body.map((r) => Object.fromEntries(head.map((h, k) => [h, /^-?\d+(\.\d+)?$/.test(r[k]) && ['Amount', 'Logged Amount'].includes(h) ? Number(r[k]) : r[k]])));
};

await check('CSV: the work sits on the SAME row as each expense, and a collection shows its booking or trial', async () => {
  const res = await get(`${Q}&format=csv`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /Finance_Report_2026-11-01_to_2026-11-30\.csv/);
  const rows = await csvRows(`${Q}&format=csv`);
  assert.deepEqual(Object.keys(rows[0]), ['Type', 'Date', 'Artist', 'Client / Work', 'Booking No.', 'Work Date', 'Category', 'Amount', 'Logged Amount', 'Status', 'Work Linked', 'Notes']);
  const fuel = rowFor(rows, (r) => r.Category === 'fuel' && r.Amount === 800);
  assert.equal(fuel['Client / Work'], 'Aysha Rahman');
  assert.equal(fuel['Booking No.'], 'BK-100');
  assert.equal(fuel.Type, 'Expense');
  assert.equal(fuel['Work Linked'], 'Chosen by the artist');
  const coll = rowFor(rows, (r) => r.Type === 'Collection' && r.Amount === 25000);
  assert.deepEqual([coll['Client / Work'], coll['Booking No.']], ['Aysha Rahman', 'BK-100']);
  const trialRow = rowFor(rows, (r) => r.Type === 'Collection' && r.Amount === 1000);
  assert.equal(trialRow['Client / Work'], 'Trial Client');
  assert.match(trialRow['Booking No.'], /^TR/, 'the trial number');
});

await check('food with no work picked is placed under the work it was eaten for, by the meal time — and says how', async () => {
  const rows = await csvRows(`${Q}&format=csv`);
  const lunch = rowFor(rows, (r) => r.Category === 'food' && r.Amount === 250);
  assert.equal(lunch['Client / Work'], 'Aysha Rahman');
  assert.equal(lunch['Booking No.'], 'BK-100');
  assert.equal(lunch['Work Linked'], 'By time of the meal', 'two works that day: the meal time decides');
  const dinner = rowFor(rows, (r) => r.Category === 'food' && r.Amount === 410);
  assert.deepEqual([dinner['Client / Work'], dinner['Booking No.']], ['Late Bride', 'BK-300'], 'the dinner is under the evening work');
});

await check('a work the artist picked herself says so', async () => {
  const rows = await csvRows(`${Q}&format=csv&employeeId=${beena._id}`);
  const lunch = rowFor(rows, (r) => r.Category === 'food' && r.Amount === 300);
  assert.equal(lunch['Work Linked'], 'Chosen by the artist', 'she picked it herself');
});

await check('an expense with no work to belong to says so; a model shoot says that', async () => {
  const rows = await csvRows(`${Q}&format=csv`);
  const toll = rowFor(rows, (r) => r.Category === 'travel' && r.Amount === 120);
  assert.equal(toll['Client / Work'], 'Not tied to a work');
  assert.equal(toll['Booking No.'], '');
  const shoot = rowFor(rows, (r) => r.Amount === 99);
  assert.equal(shoot['Client / Work'], 'Model shoot');
});

await check('approved for less: Amount is what was approved, Logged Amount what the artist logged', async () => {
  const rows = await csvRows(`${Q}&format=csv`);
  const stay = rowFor(rows, (r) => r.Category === 'stay');
  assert.deepEqual([stay.Amount, stay['Logged Amount']], [1400, 1517]);
  assert.equal(rowFor(rows, (r) => r.Category === 'fuel' && r.Amount === 800)['Logged Amount'], '');
});

await check('rejected entries are listed (with their status) and every expense row has a work column', async () => {
  const rows = await csvRows(`${Q}&format=csv`);
  assert.equal(rowFor(rows, (r) => r.Amount === 5000).Status, 'rejected');
  assert.equal(rows.filter((r) => r.Type === 'Expense').length, 8);
  assert.equal(rows.filter((r) => r.Type === 'Collection').length, 2);
  assert.ok(rows.filter((r) => r.Type === 'Expense').every((r) => r['Client / Work'] !== ''), 'no expense row has a blank work');
});

await check('CSV: a note typed as a formula is not one when the file is opened', async () => {
  const text = await (await get(`${Q}&format=csv`)).text();
  assert.ok(text.includes(`"'=HYPERLINK(`), 'prefixed so the spreadsheet shows it as text');
  assert.ok(!/"=HYPERLINK/.test(text));
});

await check('Excel: a real .xlsx — real dates and numbers, the same columns, and a Summary sheet', async () => {
  const res = await get(`${Q}&format=xlsx`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /\.xlsx/);
  assert.match(res.headers.get('content-type'), /spreadsheetml/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(0, 2).toString(), 'PK', 'a zip, as every .xlsx is');
  const rows = sheet(buf);
  const fuel = rowFor(rows, (r) => r.Category === 'fuel' && r.Amount === 800);
  assert.equal(fuel['Client / Work'], 'Aysha Rahman');
  assert.ok(fuel.Date instanceof Date, 'a date, not text');
  assert.equal(fuel.Date.toISOString().slice(0, 10), '2026-11-12', 'the IST day');
  assert.equal(fuel['Work Date'].toISOString().slice(0, 10), '2026-11-12');
  assert.equal(typeof fuel.Amount, 'number');
  const summary = sheet(buf, 'Summary');
  assert.ok(summary.length > 0);
  const wb = XLSX.read(buf, { type: 'buffer' });
  const s = XLSX.utils.sheet_to_json(wb.Sheets.Summary, { header: 1, defval: '' });
  const flat = s.map((r) => r.join('|'));
  assert.ok(flat.some((r) => r.startsWith('Total (verified + pending)|26000|')), flat.join('\n'));
  assert.ok(flat.some((r) => r.includes('Rejected (not counted)|0|5000')), 'the rejected 5,000 is shown but not counted');
});

await check('PDF: a valid landscape document', async () => {
  const res = await get(`${Q}&format=pdf`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /\.pdf/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(buf.length > 2000);
  if (process.env.FR_SAVE_DIR) writeFileSync(join(process.env.FR_SAVE_DIR, 'report.pdf'), buf); // to look at it
  // when pdftotext is on this machine, read what is on the page
  let text = null;
  try {
    const dir = mkdtempSync(join(tmpdir(), 'fr-pdf-'));
    writeFileSync(join(dir, 'r.pdf'), buf);
    text = execFileSync('pdftotext', ['-layout', join(dir, 'r.pdf'), '-'], { encoding: 'utf8' });
  } catch {
    console.log('      (pdftotext not available — the PDF text was not read)');
  }
  if (text) {
    const line = text.split('\n').find((l) => l.includes('Rs. 800'));
    assert.ok(line, text);
    assert.ok(line.includes('Aysha Rahman'), `the work is on the SAME line as the expense: ${line}`);
    assert.ok(text.includes('Not tied to a work'));
    assert.ok(text.includes('logged Rs. 1,517'));
    assert.ok(text.includes('Net balance'));
    assert.ok(!text.includes('₹') && !text.includes('¹'), 'no broken rupee sign');
  }
});

await check('the month form the older apps send still works, in every format', async () => {
  for (const format of ['csv', 'xlsx', 'pdf']) {
    const res = await get(`month=11&year=2026&format=${format}`);
    assert.equal(res.status, 200, format);
    assert.match(res.headers.get('content-disposition'), /Finance_Report_11_2026\./);
  }
});

await check('one artist only, and a bad range is refused', async () => {
  const rows = await csvRows(`${Q}&format=csv&employeeId=${beena._id}`);
  assert.ok(rows.length > 0 && rows.every((r) => r.Artist === 'Beena'));
  assert.equal((await get('from=2026-11-20&to=2026-11-01&format=csv')).status, 400);
});

console.log(`\n${pass} passed, ${failures.length} failed`);
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
server.close();
process.exit(failures.length === 0 ? 0 : 1);
