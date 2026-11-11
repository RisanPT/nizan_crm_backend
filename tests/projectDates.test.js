// Pure unit tests: node --test tests/projectDates.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkProjectDates } from '../utils/projectDates.js';

test('a plain day is read as that day at 00:00 UTC; an ISO instant is kept', () => {
  const r = checkProjectDates({ startDate: '2026-11-03', endDate: '2026-11-20T00:00:00.000Z' });
  assert.equal(r.startDate.toISOString(), '2026-11-03T00:00:00.000Z');
  assert.equal(r.endDate.toISOString(), '2026-11-20T00:00:00.000Z');
});

test('only the dates that were sent come back (an edit that does not touch them leaves them alone)', () => {
  assert.deepEqual(checkProjectDates({}), {});
  assert.deepEqual(Object.keys(checkProjectDates({ endDate: '2026-12-01' })), ['endDate']);
});

test('an end date before the start is refused; the same day is fine', () => {
  assert.match(checkProjectDates({ startDate: '2026-11-10', endDate: '2026-11-09' }).error, /end date is before the start/);
  assert.equal(checkProjectDates({ startDate: '2026-11-10', endDate: '2026-11-10' }).error, undefined);
});

test('an edit is judged against the stored dates', () => {
  const existing = { startDate: new Date('2026-11-10T00:00:00Z'), endDate: new Date('2026-12-10T00:00:00Z') };
  assert.match(checkProjectDates({ endDate: '2026-11-01' }, existing).error, /before the start/, 'a new end before the stored start');
  assert.match(checkProjectDates({ startDate: '2027-01-01' }, existing).error, /before the start/, 'a new start after the stored end');
  assert.equal(checkProjectDates({ startDate: '2026-11-12' }, existing).error, undefined);
});

test('an empty end date clears it (null); an empty start date is refused', () => {
  assert.equal(checkProjectDates({ endDate: '' }).endDate, null);
  assert.equal(checkProjectDates({ endDate: null }).endDate, null);
  assert.match(checkProjectDates({ startDate: '' }).error, /needs a start date/);
  assert.equal(checkProjectDates({ endDate: '' }, { startDate: new Date('2026-11-10'), endDate: new Date('2026-12-10') }).error, undefined, 'clearing an end date is allowed');
});

test('a value that is not a date is refused', () => {
  assert.match(checkProjectDates({ startDate: 'tomorrow' }).error, /start date is not a valid/);
  assert.match(checkProjectDates({ endDate: '2026-13-45' }).error, /end date is not a valid/);
});
