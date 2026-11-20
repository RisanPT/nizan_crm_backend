// The period a report is for (utils/reportPeriod.js): node --test tests/reportPeriod.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_REPORT_DAYS, daysInclusive, followingPeriod, periodLabel, resolveReportPeriod } from '../utils/reportPeriod.js';

const iso = (d) => d.toISOString();

test('a range: IST days, both ends in — the last day to its last millisecond', () => {
  const p = resolveReportPeriod({ from: '2026-11-01', to: '2026-11-17' });
  assert.deepEqual([p.from, p.to, p.days, p.custom, p.tag], ['2026-11-01', '2026-11-17', 17, true, '2026-11-01_to_2026-11-17']);
  assert.equal(iso(p.start), '2026-10-31T18:30:00.000Z'); // 00:00 IST
  assert.equal(iso(p.end), '2026-11-17T18:29:59.999Z'); // 23:59:59.999 IST
  assert.equal(p.label, '1 Nov – 17 Nov 2026');
});

test('one day is a range of one', () => {
  const p = resolveReportPeriod({ from: '2026-11-17', to: '2026-11-17' });
  assert.deepEqual([p.days, p.tag, p.label], [1, '2026-11-17', '17 Nov 2026']);
});

test('the dates an older app sends — local midnight with no zone — read as that day', () => {
  const p = resolveReportPeriod({ from: '2026-11-01T00:00:00.000', to: '2026-11-17T00:00:00.000' });
  assert.deepEqual([p.from, p.to], ['2026-11-01', '2026-11-17']);
});

test('a range is refused, in words and with a code, when it cannot be read, runs backwards or is too long', () => {
  assert.equal(resolveReportPeriod({ from: '2026-11-17', to: '2026-11-01' }).code, 'RANGE_REVERSED');
  assert.equal(resolveReportPeriod({ from: '2026-11-01' }).code, 'RANGE_INVALID', 'both dates are needed');
  assert.equal(resolveReportPeriod({ to: '2026-11-01' }).code, 'RANGE_INVALID');
  assert.equal(resolveReportPeriod({ from: 'soon', to: 'later' }).code, 'RANGE_INVALID');
  assert.equal(resolveReportPeriod({ from: '2026-11-01', to: '2026-11-31x' }).code, 'RANGE_INVALID');
  const long = resolveReportPeriod({ from: '2020-01-01', to: '2026-01-01' });
  assert.equal(long.code, 'RANGE_TOO_LONG');
  assert.match(long.error, new RegExp(String(MAX_REPORT_DAYS)));
  // exactly the longest is fine, one more is not
  assert.equal(resolveReportPeriod({ from: '2025-01-01', to: '2027-03-11' }).days, MAX_REPORT_DAYS);
  assert.equal(resolveReportPeriod({ from: '2025-01-01', to: '2027-03-12' }).code, 'RANGE_TOO_LONG');
  assert.equal(resolveReportPeriod({ from: '2020-01-01', to: '2026-01-01' }, { maxDays: 4000 }).custom, true);
});

test('a range wins over a month', () => {
  const p = resolveReportPeriod({ from: '2026-11-03', to: '2026-11-05', month: '1', year: '2026' });
  assert.deepEqual([p.from, p.to, p.custom], ['2026-11-03', '2026-11-05', true]);
});

test('the older month + year still works, with its own file name', () => {
  const p = resolveReportPeriod({ month: '2', year: '2028' });
  assert.deepEqual([p.from, p.to, p.custom, p.month, p.year, p.days], ['2028-02-01', '2028-02-29', false, 2, 2028, 29]);
  assert.equal(iso(p.start), '2028-01-31T18:30:00.000Z');
});

test('a month with a number out of range, or nothing at all, is refused', () => {
  for (const q of [{}, { month: '13', year: '2026' }, { month: '0', year: '2026' }, { month: '5', year: '1999' }, { month: 'x', year: '2026' }, { month: '5' }, { year: '2026' }]) {
    assert.equal(resolveReportPeriod(q).code, 'PERIOD_REQUIRED', JSON.stringify(q));
  }
});

test('the analyst form: month=YYYY-MM, or this month when nothing is given', () => {
  const p = resolveReportPeriod({ month: '2026-11' }, { monthIsText: true });
  assert.deepEqual([p.from, p.to, p.month, p.year, p.custom], ['2026-11-01', '2026-11-30', 11, 2026, false]);
  assert.equal(resolveReportPeriod({ month: '2026-13' }, { monthIsText: true }).code, 'PERIOD_REQUIRED');
  const now = resolveReportPeriod({}, { monthIsText: true, defaultToThisMonth: true });
  assert.equal(now.custom, false);
  assert.equal(now.days >= 28 && now.days <= 31, true);
  assert.equal(resolveReportPeriod({ month: 'junk' }, { monthIsText: true, defaultToThisMonth: true }).custom, false, 'unreadable falls back to this month, as the analyst report always did');
});

test('the stretch that follows: the next month for a month, the same number of days for a range', () => {
  const m = followingPeriod(resolveReportPeriod({ month: '2026-12' }, { monthIsText: true }));
  assert.deepEqual([m.from, m.to], ['2027-01-01', '2027-01-31']);
  const feb = followingPeriod(resolveReportPeriod({ month: '2027-01' }, { monthIsText: true }));
  assert.deepEqual([feb.from, feb.to], ['2027-02-01', '2027-02-28']);
  const r = followingPeriod(resolveReportPeriod({ from: '2026-11-10', to: '2026-11-16' }));
  assert.deepEqual([r.from, r.to], ['2026-11-17', '2026-11-23']);
  const wrap = followingPeriod(resolveReportPeriod({ from: '2026-12-29', to: '2027-01-02' }));
  assert.deepEqual([wrap.from, wrap.to], ['2027-01-03', '2027-01-07']);
  assert.equal(iso(r.start), '2026-11-16T18:30:00.000Z');
});

test('days counted, and the label said the way the app says it', () => {
  assert.equal(daysInclusive('2026-11-01', '2026-11-01'), 1);
  assert.equal(daysInclusive('2026-12-30', '2027-01-02'), 4);
  assert.equal(periodLabel('2026-10-28', '2026-11-03'), '28 Oct – 3 Nov 2026');
  assert.equal(periodLabel('2025-12-28', '2026-01-03'), '28 Dec 2025 – 3 Jan 2026');
});
