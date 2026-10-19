// Pure unit tests (no database, no server): node --test tests/istDate.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  fromBound,
  istDayKey,
  istEnd,
  istMonthBounds,
  istMonthKey,
  istStart,
  istWeekStart,
  parseDayParam,
  rangeCondition,
  toBound,
} from '../utils/istDate.js';

test('IST day boundaries', () => {
  assert.equal(istStart('2026-10-01').toISOString(), '2026-09-30T18:30:00.000Z');
  assert.equal(istEnd('2026-10-31').toISOString(), '2026-10-31T18:29:59.999Z');
});

test('istDayKey uses the IST calendar, not UTC', () => {
  // 1 Nov 00:30 IST is still 31 Oct in UTC.
  assert.equal(istDayKey(new Date('2026-10-31T19:00:00Z')), '2026-11-01');
  assert.equal(istMonthKey(new Date('2026-10-31T19:00:00Z')), '2026-11');
  // 31 Oct 23:59 IST
  assert.equal(istDayKey(new Date('2026-10-31T18:29:00Z')), '2026-10-31');
});

test('parseDayParam accepts plain days and old-style ISO strings', () => {
  assert.equal(parseDayParam('2026-10-05'), '2026-10-05');
  assert.equal(parseDayParam('2026-10-05T00:00:00.000'), '2026-10-05'); // old app builds
  assert.equal(parseDayParam('2026-10-04T18:30:00.000Z'), '2026-10-05'); // IST midnight sent as UTC
  assert.equal(parseDayParam('2026-10-05T00:00:00+05:30'), '2026-10-05');
  assert.equal(parseDayParam(new Date('2026-10-31T19:00:00Z')), '2026-11-01');
  assert.equal(parseDayParam(''), null);
  assert.equal(parseDayParam(null), null);
  assert.equal(parseDayParam('not a date'), null);
});

test('to includes its whole day; from starts at 00:00 IST', () => {
  assert.equal(fromBound('2026-10-01').toISOString(), '2026-09-30T18:30:00.000Z');
  assert.equal(toBound('2026-10-31T00:00:00.000').toISOString(), '2026-10-31T18:29:59.999Z');
});

test('Date bounds are exact instants and left alone', () => {
  const d = new Date('2026-10-01T00:00:00Z');
  assert.equal(fromBound(d), d);
  assert.equal(toBound(d), d);
});

test('a booking just after midnight IST belongs to the next month', () => {
  const booking = new Date('2026-10-31T19:00:00Z'); // 1 Nov 00:30 IST
  const oct = rangeCondition('d', '2026-10-01', '2026-10-31').d;
  const nov = rangeCondition('d', '2026-11-01', '2026-11-30').d;
  assert.ok(!(booking >= oct.$gte && booking <= oct.$lte));
  assert.ok(booking >= nov.$gte && booking <= nov.$lte);
});

test('a booking on the last selected day is included', () => {
  const booking = new Date('2026-10-31T10:00:00Z'); // 31 Oct 15:30 IST
  const r = rangeCondition('d', '2026-10-01', '2026-10-31').d;
  assert.ok(booking >= r.$gte && booking <= r.$lte);
});

test('rangeCondition ignores unreadable input instead of hiding data', () => {
  assert.deepEqual(rangeCondition('d', '', undefined), {});
  assert.deepEqual(rangeCondition('d', 'garbage', null), {});
  assert.deepEqual(Object.keys(rangeCondition('d', '2026-10-01', undefined).d), ['$gte']);
});

test('weeks start on Monday', () => {
  assert.equal(istWeekStart('2026-10-19'), '2026-10-19'); // Monday
  assert.equal(istWeekStart('2026-10-25'), '2026-10-19'); // Sunday
  assert.equal(istWeekStart('2026-10-26'), '2026-10-26'); // next Monday
  // 1 Nov 00:30 IST (a Sunday) is in the week starting Mon 26 Oct.
  assert.equal(istWeekStart(new Date('2026-10-31T19:00:00Z')), '2026-10-26');
});

test('istMonthBounds and addDays', () => {
  assert.equal(istMonthBounds(2026, 2).to, '2026-02-28');
  assert.equal(istMonthBounds(2028, 2).to, '2028-02-29');
  assert.equal(istMonthBounds(2026, 12).to, '2026-12-31');
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('day, week and month rollups reconcile with no gaps or double counting', () => {
  // A booking every 37 minutes across Oct-Nov 2026.
  const start = Date.parse('2026-09-28T00:00:00Z');
  const instants = [];
  for (let t = start; t < Date.parse('2026-11-10T00:00:00Z'); t += 37 * 60 * 1000) {
    instants.push(new Date(t));
  }
  const count = (keyFn) => {
    const m = new Map();
    for (const d of instants) m.set(keyFn(d), (m.get(keyFn(d)) || 0) + 1);
    return m;
  };
  const days = count(istDayKey);
  const weeks = count(istWeekStart);
  const months = count(istMonthKey);

  const total = instants.length;
  assert.equal([...days.values()].reduce((a, b) => a + b, 0), total);
  assert.equal([...weeks.values()].reduce((a, b) => a + b, 0), total);
  assert.equal([...months.values()].reduce((a, b) => a + b, 0), total);

  for (const [week, n] of weeks) {
    let sum = 0;
    for (const [day, c] of days) if (istWeekStart(day) === week) sum += c;
    assert.equal(sum, n, `week ${week}`);
  }
  for (const [month, n] of months) {
    let sum = 0;
    for (const [day, c] of days) if (day.startsWith(month)) sum += c;
    assert.equal(sum, n, `month ${month}`);
  }
});
