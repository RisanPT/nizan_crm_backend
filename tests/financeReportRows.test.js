// The rows of the Finance Report (utils/financeReportRows.js) and its files (services/financeReportFiles.js):
// node --test tests/financeReportRows.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { FINANCE_COLUMNS, LINKED_LABELS, NOT_TIED, buildFinanceRows, csvRecord, csvSafe, dayText, summarizeFinanceRows } from '../utils/financeReportRows.js';
import { financeCsv, financeXlsx, newFinancePdf, writeFinancePdf } from '../services/financeReportFiles.js';

const at = (day, hhmm = '12:00') => new Date(`${day}T${hhmm}:00+05:30`);
const booking = (id, no, client, day) => ({ _id: id, bookingNumber: no, customerName: client, serviceStart: day ? at(day, '09:00') : null });
const info = (id, no, client, day) => ({ bookingId: id, bookingNumber: no, customerName: client, serviceStart: at(day, '09:00') });
const exp = (id, extra = {}) => ({ _id: id, employeeId: { name: 'Asha' }, category: 'food', amount: 100, status: 'verified', workType: 'bridal', date: at('2026-11-12'), notes: '', ...extra });
const coll = (id, extra = {}) => ({ _id: id, employeeId: { name: 'Asha' }, amount: 1000, status: 'verified', date: at('2026-11-12'), notes: '', ...extra });
const alloc = (entries, works) => ({
  byExpense: new Map(entries.map(([id, mode, bookingIds]) => [id, { mode, shares: bookingIds.map((b) => ({ bookingId: b, amount: 1 })) }])),
  bookings: new Map(works.map((w) => [w.bookingId, w])),
});

test('the days are the IST day, whatever the server clock', () => {
  assert.equal(dayText('2026-11-05'), '5 Nov 2026');
  assert.equal(dayText(''), '');
  // 23:30 IST on the 12th is the 12th even though it is 18:00 UTC; 00:30 IST on the 13th is the 13th though it is the 12th in UTC
  const { expenses } = buildFinanceRows({ expenses: [exp('a', { date: at('2026-11-12', '23:30') }), exp('b', { date: at('2026-11-13', '00:30') })] });
  assert.deepEqual(expenses.map((r) => r.dayText).sort(), ['12 Nov 2026', '13 Nov 2026']);
});

test('an expense the allocation placed shows that work on its own row, and how it was decided', () => {
  const w = info('w1', 'BK-1', 'Aysha', '2026-11-12');
  const { expenses } = buildFinanceRows({
    expenses: [exp('e1'), exp('e2', { category: 'fuel' }), exp('e3'), exp('e4')],
    allocation: alloc([['e1', 'time', ['w1']], ['e2', 'pinned', ['w1']], ['e3', 'single', ['w1']], ['e4', 'last', ['w1']]], [w]),
  });
  const by = Object.fromEntries(expenses.map((r) => [r.category + r.linked, r]));
  for (const r of expenses) {
    assert.deepEqual([r.client, r.bookingNo, r.workDayText], ['Aysha', 'BK-1', '12 Nov 2026']);
  }
  assert.deepEqual(expenses.map((r) => r.linked).sort(), ['By time of the meal', 'Chosen by the artist', 'Last work of the day', 'Only work that day']);
  assert.ok(by['fuelChosen by the artist']);
});

test('an expense split across two works names both', () => {
  const { expenses } = buildFinanceRows({
    expenses: [exp('e1')],
    allocation: alloc([['e1', 'time', ['w1', 'w2']]], [info('w1', 'BK-1', 'Aysha', '2026-11-12'), info('w2', 'BK-2', 'Sana', '2026-11-13')]),
  });
  assert.deepEqual([expenses[0].client, expenses[0].bookingNo, expenses[0].workDayText, expenses[0].workDays], ['Aysha + Sana', 'BK-1 + BK-2', '12 Nov 2026 + 13 Nov 2026', ['2026-11-12', '2026-11-13']]);
});

test('with no allocation the booking the artist tied the expense to still shows', () => {
  const { expenses } = buildFinanceRows({ expenses: [exp('e1', { bookingId: booking('w9', 'BK-9', 'Nadiya', '2026-11-12') })] });
  assert.deepEqual([expenses[0].client, expenses[0].bookingNo, expenses[0].linked], ['Nadiya', 'BK-9', LINKED_LABELS.pinned]);
});

test('an expense with no work says so — a model shoot says that — and never a blank', () => {
  const { expenses } = buildFinanceRows({ expenses: [exp('e1'), exp('e2', { workType: 'model_shoot' })] });
  const by = Object.fromEntries(expenses.map((r) => [r.client, r]));
  assert.equal(by[NOT_TIED].bookingNo, '');
  assert.equal(by[NOT_TIED].linked, '');
  assert.equal(by['Model shoot'].linked, LINKED_LABELS.shoot);
  assert.ok(expenses.every((r) => r.client.length > 0));
});

test('a booking with no customer name falls back to its number, never blank', () => {
  const { expenses } = buildFinanceRows({ expenses: [exp('e1', { bookingId: { _id: 'w1', bookingNumber: 'BK-77', customerName: '' } })] });
  assert.equal(expenses[0].client, 'BK-77');
});

test('collections: the booking or the trial, its number and the work day', () => {
  const { collections } = buildFinanceRows({
    collections: [
      coll('c1', { bookingId: booking('w1', 'BK-1', 'Aysha', '2026-11-12') }),
      coll('c2', { trialId: { _id: 't1', trialNumber: 'TR-5', clientName: 'Sana' }, amount: 500 }),
      coll('c3', { amount: 7 }),
    ],
  });
  const by = Object.fromEntries(collections.map((r) => [r.amount, r]));
  assert.deepEqual([by[1000].client, by[1000].bookingNo, by[1000].workDayText], ['Aysha', 'BK-1', '12 Nov 2026']);
  assert.deepEqual([by[500].client, by[500].bookingNo, by[500].workDayText], ['Sana', 'TR-5', '']);
  assert.deepEqual([by[7].client, by[7].bookingNo], ['N/A', '']);
  assert.equal(by[1000].category, '');
});

test('approved for less: the amount that counts, and the logged one beside it', () => {
  const { expenses } = buildFinanceRows({ expenses: [exp('e1', { amount: 1400, loggedAmount: 1517 }), exp('e2', { amount: 300, loggedAmount: null }), exp('e3', { amount: 50, loggedAmount: 50 })] });
  const by = Object.fromEntries(expenses.map((r) => [r.amount, r]));
  assert.equal(by[1400].loggedAmount, 1517);
  assert.equal(by[300].loggedAmount, null);
  assert.equal(by[50].loggedAmount, null, 'not reduced: nothing to show');
});

test('newest first, collections and expenses kept apart', () => {
  const { collections, expenses } = buildFinanceRows({
    collections: [coll('c1', { date: at('2026-11-01') }), coll('c2', { date: at('2026-11-16') })],
    expenses: [exp('e1', { date: at('2026-11-05') }), exp('e2', { date: at('2026-11-05', '18:00'), createdAt: at('2026-11-05', '18:00') }), exp('e3', { date: at('2026-11-09') })],
  });
  assert.deepEqual(collections.map((r) => r.dayText), ['16 Nov 2026', '1 Nov 2026']);
  assert.deepEqual(expenses.map((r) => r.dayText), ['9 Nov 2026', '5 Nov 2026', '5 Nov 2026']);
});

test('the totals: rejected is listed but never counted; the net is counted − counted', () => {
  const rows = buildFinanceRows({
    collections: [coll('c1', { amount: 1000 }), coll('c2', { amount: 400, status: 'pending' }), coll('c3', { amount: 77, status: 'rejected' })],
    expenses: [exp('e1', { amount: 300 }), exp('e2', { amount: 120.5, status: 'pending' }), exp('e3', { amount: 5000, status: 'rejected' })],
  });
  const s = summarizeFinanceRows(rows);
  assert.deepEqual(s.collections, { verified: 1000, pending: 400, rejected: 77, counted: 1400, count: 3 });
  assert.deepEqual(s.expenses, { verified: 300, pending: 120.5, rejected: 5000, counted: 420.5, count: 3 });
  assert.equal(s.net, 979.5);
});

test('a note typed as a formula is made text in the CSV; numbers stay numbers', () => {
  assert.equal(csvSafe('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(csvSafe('+91 98'), "'+91 98");
  assert.equal(csvSafe('@x'), "'@x");
  assert.equal(csvSafe('-1'), "'-1");
  assert.equal(csvSafe('petrol'), 'petrol');
  assert.equal(csvSafe(null), '');
  const { expenses } = buildFinanceRows({ expenses: [exp('e1', { notes: '=1+1', amount: 25 })] });
  const rec = csvRecord(expenses[0]);
  assert.equal(rec.Notes, "'=1+1");
  assert.equal(rec.Amount, 25);
  assert.deepEqual(Object.keys(rec), FINANCE_COLUMNS.map(([h]) => h));
});

test('the CSV: a header, then one line per entry — collections first — with the work on the same line', () => {
  const rows = buildFinanceRows({
    collections: [coll('c1', { bookingId: booking('w1', 'BK-1', 'Aysha', '2026-11-12') })],
    expenses: [exp('e1', { notes: 'with "quotes", and a comma' })],
    allocation: alloc([['e1', 'pinned', ['w1']]], [info('w1', 'BK-1', 'Aysha', '2026-11-12')]),
  });
  const lines = financeCsv(rows).split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], '"Type","Date","Artist","Client / Work","Booking No.","Work Date","Category","Amount","Logged Amount","Status","Work Linked","Notes"');
  assert.ok(lines[1].startsWith('"Collection","12 Nov 2026","Asha","Aysha","BK-1"'));
  assert.ok(lines[2].startsWith('"Expense","12 Nov 2026","Asha","Aysha","BK-1","12 Nov 2026","food",100,'));
  assert.ok(lines[2].includes('"with ""quotes"", and a comma"'));
});

test('the Excel file is a workbook with the sheet and the summary, real dates and numbers', async () => {
  const XLSX = (await import('xlsx')).default;
  const rows = buildFinanceRows({
    collections: [coll('c1', { bookingId: booking('w1', 'BK-1', 'Aysha', '2026-11-12') })],
    expenses: [exp('e1', { amount: 1400, loggedAmount: 1517 })],
    allocation: alloc([['e1', 'pinned', ['w1']]], [info('w1', 'BK-1', 'Aysha', '2026-11-12')]),
  });
  const buf = await financeXlsx(rows, { label: '1 Nov – 30 Nov 2026' });
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  assert.deepEqual(wb.SheetNames, ['Finance Report', 'Summary']);
  const data = XLSX.utils.sheet_to_json(wb.Sheets['Finance Report'], { defval: '' });
  assert.equal(data.length, 2);
  const e = data.find((r) => r.Type === 'Expense');
  assert.equal(e['Client / Work'], 'Aysha');
  assert.equal(e.Amount, 1400);
  assert.equal(e['Logged Amount'], 1517);
  assert.ok(e.Date instanceof Date && e.Date.toISOString().slice(0, 10) === '2026-11-12');
  assert.ok(wb.Sheets['Finance Report']['!autofilter'], 'filterable');
});

test('the PDF runs onto more pages when there are many rows', async () => {
  const expenses = Array.from({ length: 120 }, (_, i) => exp(`e${i}`, { amount: 100 + i, notes: `note ${i} `.repeat(6), date: at('2026-11-12', '10:00') }));
  const rows = buildFinanceRows({ expenses, collections: [coll('c1')] });
  const doc = newFinancePdf();
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  writeFinancePdf(doc, rows, { label: '1 Nov – 30 Nov 2026' });
  const pages = doc.bufferedPageRange().count;
  const done = new Promise((resolve) => doc.on('end', resolve));
  doc.end();
  await done;
  assert.ok(pages >= 3, `120 expenses need several pages, got ${pages}`);
  assert.equal(Buffer.concat(chunks).subarray(0, 5).toString(), '%PDF-');
});

test('an empty period still makes a report (and the PDF says there is nothing)', () => {
  const rows = buildFinanceRows({});
  assert.deepEqual(rows, { collections: [], expenses: [] });
  const doc = newFinancePdf();
  writeFinancePdf(doc, rows, { label: 'x' });
  doc.end();
  assert.equal(financeCsv(rows).split('\n').length, 1, 'just the header');
});
