// The statement of a bank / cash account (utils/bankStatement.js): node --test tests/bankStatement.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { StatementError, anchorAt, anchorsOf, balanceAt, cutoffOf, facetsOf, matchesRow, pageOf, parseStatementQuery, rangeOf, totalsOf, withRunningBalance } from '../utils/bankStatement.js';

const at = (day, hhmm = '12:00') => new Date(`${day}T${hhmm}:00+05:30`);
const line = (day, inAmt, outAmt, hhmm) => ({ date: at(day, hhmm), in: inAmt, out: outAmt });
const iso = (d) => d.toISOString();

test('a manual balance covers its whole IST day: movements count from the next day', () => {
  assert.equal(iso(cutoffOf(at('2026-10-31', '09:00'))), '2026-10-31T18:29:59.999Z'); // 23:59:59.999 IST
  assert.equal(iso(cutoffOf(new Date('2026-10-31T19:00:00Z'))), '2026-11-01T18:29:59.999Z', '00:30 IST on the 1st is the 1st');
  assert.equal(cutoffOf(null), null);
});

test('the balances in force: oldest first, ending with the one in force now', () => {
  const account = {
    balance: 30000,
    asOf: at('2026-11-12'),
    history: [
      { balance: 10000, asOf: at('2026-10-31') },
      { balance: 99999, asOf: at('2026-11-20') }, // dated after the current one: replaced when it was entered
      { balance: 11111, asOf: at('2026-10-31', '18:00') }, // a second entry for the 31st: the later one wins
      { balance: 30000, asOf: at('2026-11-12') }, // the current one's own history row
    ],
  };
  const a = anchorsOf(account);
  assert.deepEqual(a.map((x) => x.balance), [11111, 30000]);
  assert.equal(iso(a[1].cutoff), iso(cutoffOf(at('2026-11-12'))));
});

test('an account with no as-of date counts every movement from the beginning', () => {
  const a = anchorsOf({ balance: 500, asOf: null, history: [] });
  assert.equal(a.length, 1);
  assert.equal(a[0].cutoff.getTime(), 0);
  assert.deepEqual(withRunningBalance(a, [line('2020-01-01', 100, 0)]).map((l) => l.balance), [600]);
});

test('the balance after each line: the manual balance in force, plus receipts minus payments since', () => {
  const anchors = anchorsOf({ balance: 30000, asOf: at('2026-11-12'), history: [{ balance: 10000, asOf: at('2026-10-31') }] });
  const lines = [
    line('2026-10-20', 500, 0), // before any balance was entered
    line('2026-10-31', 0, 70, '23:00'), // ON the balance's day: already inside it
    line('2026-11-01', 25000, 0, '00:10'),
    line('2026-11-08', 0, 1400),
    line('2026-11-12', 0, 999, '23:59'), // on the second balance's day: inside it
    line('2026-11-13', 0, 2000, '00:00'),
    line('2026-11-15', 300, 0),
  ];
  assert.deepEqual(withRunningBalance(anchors, lines).map((l) => l.balance), [null, null, 35000, 33600, 32601, 28000, 28300]);
});

test('paise do not drift', () => {
  const anchors = anchorsOf({ balance: 0.1, asOf: at('2026-10-31'), history: [] });
  const out = withRunningBalance(anchors, [line('2026-11-01', 0.2, 0), line('2026-11-02', 0, 0.3)]);
  assert.deepEqual(out.map((l) => l.balance), [0.3, 0]);
});

test('the balance at a moment: null before the first manual balance, the balance itself on its day', () => {
  const anchors = anchorsOf({ balance: 30000, asOf: at('2026-11-12'), history: [{ balance: 10000, asOf: at('2026-10-31') }] });
  const lines = [line('2026-11-01', 25000, 0), line('2026-11-08', 0, 1400), line('2026-11-13', 0, 2000)];
  assert.equal(balanceAt(anchors, lines, at('2026-10-30')), null);
  assert.equal(balanceAt(anchors, lines, cutoffOf(at('2026-10-31'))), 10000);
  assert.equal(balanceAt(anchors, lines, at('2026-11-05')), 35000);
  assert.equal(balanceAt(anchors, lines, at('2026-11-10')), 33600);
  assert.equal(balanceAt(anchors, lines, at('2026-11-12', '23:59')), 33600, 'a manual balance is the CLOSING balance of its day: until the day ends the running one stands');
  assert.equal(balanceAt(anchors, lines, cutoffOf(at('2026-11-12'))), 30000, 'then it replaces the running one');
  assert.equal(balanceAt(anchors, lines, at('2026-11-20')), 28000);
  assert.equal(anchorAt(anchors, at('2026-10-30')), null);
  assert.equal(anchorAt(anchors, at('2026-11-20')).balance, 30000);
});

test('reading the request: nothing sent is the older app (every row, oldest first)', () => {
  const q = parseStatementQuery({});
  assert.deepEqual([q.from, q.to, q.direction, q.group, q.person, q.search, q.legacy, q.paged, q.export], [null, null, null, null, null, '', true, false, false]);
  assert.deepEqual(rangeOf(q), { start: null, end: null });
});

test('reading the request: a page, filters and a range (both days inclusive)', () => {
  const q = parseStatementQuery({ page: '2', limit: '8', from: '2026-11-01', to: '2026-11-30', direction: 'OUT', group: 'artist_expense:food', person: 'e1', search: '  megha ' });
  assert.deepEqual([q.page, q.limit, q.legacy, q.paged], [2, 8, false, true]);
  assert.deepEqual([q.from, q.to, q.direction, q.group, q.person, q.search], ['2026-11-01', '2026-11-30', 'out', 'artist_expense:food', 'e1', 'megha']);
  const r = rangeOf(q);
  assert.equal(iso(r.start), '2026-10-31T18:30:00.000Z');
  assert.equal(iso(r.end), '2026-11-30T18:29:59.999Z');
  assert.equal(parseStatementQuery({ limit: '9999' }).limit, 100, 'capped');
  assert.equal(parseStatementQuery({ page: '-3' }).page, 1);
  assert.equal(parseStatementQuery({ export: '1' }).legacy, false);
});

test('reading the request: what is refused', () => {
  assert.throws(() => parseStatementQuery({ from: '2026-11-20', to: '2026-11-01' }), StatementError);
  assert.throws(() => parseStatementQuery({ from: 'yesterday' }), /From must be a day/);
  assert.throws(() => parseStatementQuery({ direction: 'sideways' }), /direction/);
  assert.equal(new StatementError('x').status, 400);
});

const row = (extra) => ({ in: 0, out: 100, group: 'artist_expense:food', groupLabel: 'Artist expense · Food', personKey: 'e1', person: { name: 'Anjali TK', role: 'Artist' }, particulars: 'Artist expense · Food', title: 'Megha', client: 'Megha', bookingNumber: '2604161274', voucherNo: 'PAY/2026-27/0282', notes: 'team lunch', ...extra });

test('filters: direction, category, person and free text (client, booking no., voucher, artist, notes, amount)', () => {
  const r = row();
  assert.equal(matchesRow(r, {}), true);
  assert.equal(matchesRow(r, { direction: 'out' }), true);
  assert.equal(matchesRow(r, { direction: 'in' }), false);
  assert.equal(matchesRow(row({ in: 500, out: 0 }), { direction: 'in' }), true);
  assert.equal(matchesRow(r, { group: 'artist_expense:food' }), true);
  assert.equal(matchesRow(r, { group: 'fleet:fuel' }), false);
  assert.equal(matchesRow(r, { person: 'e1' }), true);
  assert.equal(matchesRow(r, { person: 'e2' }), false);
  for (const s of ['megha', 'MEGHA', '2604161', '0282', 'anjali', 'lunch', '100', 'artist expense']) assert.equal(matchesRow(r, { search: s }), true, s);
  assert.equal(matchesRow(r, { search: 'sana' }), false);
  assert.equal(matchesRow(r, { search: 'megha', direction: 'in' }), false, 'every filter must hold');
});

test('totals, facets (busiest first) and paging', () => {
  const rows = [row(), row({ out: 50 }), row({ in: 1000, out: 0, group: 'collection:booking', groupLabel: 'Collection · Booking', personKey: 'e2', person: { name: 'Megha M', role: 'Collected by' } }), row({ group: '', personKey: '' })];
  assert.deepEqual(totalsOf(rows), { in: 1000, out: 250, net: 750, count: 4 });
  const f = facetsOf(rows);
  assert.deepEqual(f.groups.map((g) => [g.key, g.label, g.count]), [['artist_expense:food', 'Artist expense · Food', 2], ['collection:booking', 'Collection · Booking', 1]]);
  assert.deepEqual(f.people.map((p) => [p.key, p.name, p.count]), [['e1', 'Anjali TK', 2], ['e2', 'Megha M', 1]]);
  const p = pageOf([1, 2, 3, 4, 5], 2, 2);
  assert.deepEqual(p, { items: [3, 4], page: 2, limit: 2, totalItems: 5, totalPages: 3 });
  assert.deepEqual(pageOf([], 1, 8), { items: [], page: 1, limit: 8, totalItems: 0, totalPages: 1 });
  assert.deepEqual(pageOf([1], 9, 8).items, [], 'past the end is empty, not an error');
});
