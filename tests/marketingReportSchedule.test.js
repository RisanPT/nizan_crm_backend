// Scheduled / saved marketing reports (utils/marketingReportSchedule.js): node --test tests/marketingReportSchedule.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanSavedReport, cleanScheduleUpdate, DEFAULT_SCHEDULES, describeSchedule, dueRun, nextRun, periodFor } from '../utils/marketingReportSchedule.js';

const ist = (s) => new Date(`${s}+05:30`);
const weekly = { cadence: 'weekly', weekday: 1, time: '10:00', enabled: true, lastPeriodKey: '' };
const monthly = { cadence: 'monthly', dayOfMonth: 1, time: '09:00', enabled: true, lastPeriodKey: '' };
const quarterly = { cadence: 'quarterly', dayOfMonth: 1, time: '09:00', enabled: true, lastPeriodKey: '' };

test('the spec\'s schedules, with their switches as drawn', () => {
  assert.equal(DEFAULT_SCHEDULES.length, 9);
  assert.deepEqual(new Set(DEFAULT_SCHEDULES.map((s) => s.module)), new Set(['team', 'campaigns', 'leads']));
  assert.equal(new Set(DEFAULT_SCHEDULES.map((s) => s.key)).size, 9, 'keys are unique');
  assert.deepEqual(DEFAULT_SCHEDULES.filter((s) => !s.enabled).map((s) => s.key), ['team.campaign-summary', 'campaigns.quarterly', 'leads.campaign-performance']);
});

test('a run covers the period that has just ended', () => {
  assert.deepEqual(periodFor('weekly', '2026-11-16'), { from: '2026-11-09', to: '2026-11-15', key: 'w:2026-11-09', label: '9 Nov – 15 Nov 2026' });
  assert.deepEqual(periodFor('monthly', '2026-12-01'), { from: '2026-11-01', to: '2026-11-30', key: 'm:2026-11', label: 'Nov 2026' });
  assert.deepEqual(periodFor('monthly', '2027-01-01').from, '2026-12-01', 'January reports December of last year');
  assert.deepEqual(periodFor('quarterly', '2026-10-01'), { from: '2026-07-01', to: '2026-09-30', key: 'q:2026-3', label: 'Q3 2026' });
  assert.deepEqual(periodFor('quarterly', '2027-01-01').key, 'q:2026-4');
});

test('due: on its day, from its time (IST), once per period, never when switched off', () => {
  assert.equal(dueRun(weekly, ist('2026-11-16T09:59:00')), null, 'Monday before ten');
  assert.equal(dueRun(weekly, ist('2026-11-16T10:00:00'))?.key, 'w:2026-11-09');
  assert.equal(dueRun(weekly, ist('2026-11-16T18:30:00'))?.key, 'w:2026-11-09', 'a server that was down at ten still runs it that day');
  assert.equal(dueRun({ ...weekly, lastPeriodKey: 'w:2026-11-09' }, ist('2026-11-16T11:00:00')), null, 'already ran for that week');
  assert.equal(dueRun(weekly, ist('2026-11-17T10:00:00')), null, 'not Tuesday');
  assert.equal(dueRun({ ...weekly, enabled: false }, ist('2026-11-16T10:00:00')), null);
  assert.equal(dueRun(weekly, new Date('2026-11-16T04:30:00Z'))?.key, 'w:2026-11-09', '04:30 UTC is 10:00 IST');
  assert.equal(dueRun(monthly, ist('2026-12-01T09:00:00'))?.key, 'm:2026-11');
  assert.equal(dueRun(monthly, ist('2026-12-02T09:00:00')), null);
  assert.equal(dueRun(quarterly, ist('2026-10-01T09:00:00'))?.key, 'q:2026-3');
  assert.equal(dueRun(quarterly, ist('2026-11-01T09:00:00')), null, 'not a quarter\'s first month');
});

test('how it reads, and when it runs next', () => {
  assert.equal(describeSchedule(weekly), 'Every Monday, 10:00 AM');
  assert.equal(describeSchedule({ ...weekly, weekday: 5, time: '18:00' }), 'Every Friday, 6:00 PM');
  assert.equal(describeSchedule(monthly), '1st of every month, 9:00 AM');
  assert.equal(describeSchedule(quarterly), '1st Jan, Apr, Jul, Oct, 9:00 AM');
  assert.equal(nextRun(weekly, ist('2026-11-18T12:00:00')).toISOString(), ist('2026-11-23T10:00:00').toISOString());
  assert.equal(nextRun(monthly, ist('2026-11-18T12:00:00')).toISOString(), ist('2026-12-01T09:00:00').toISOString());
  assert.equal(nextRun(quarterly, ist('2026-11-18T12:00:00')).toISOString(), ist('2027-01-01T09:00:00').toISOString());
  assert.equal(nextRun({ ...weekly, enabled: false }), null);
});

test('a manager\'s change: only sensible values, and only what fits the cadence', () => {
  assert.deepEqual(cleanScheduleUpdate({ enabled: true, time: '08:30' }, weekly), { set: { enabled: true, time: '08:30' } });
  assert.match(cleanScheduleUpdate({ time: '8:30' }, weekly).error, /HH:mm/);
  assert.match(cleanScheduleUpdate({ time: '24:00' }, weekly).error, /HH:mm/);
  assert.deepEqual(cleanScheduleUpdate({ weekday: 5 }, weekly), { set: { weekday: 5 } });
  assert.match(cleanScheduleUpdate({ weekday: 7 }, weekly).error, /0 \(Sunday\) to 6/);
  assert.match(cleanScheduleUpdate({ weekday: 2 }, monthly).error, /Only a weekly/);
  assert.match(cleanScheduleUpdate({ dayOfMonth: 31 }, monthly).error, /1 to 28/);
  assert.match(cleanScheduleUpdate({ dayOfMonth: 3 }, weekly).error, /no day of the month/);
});

test('a saved report: a known module, a kind, a period the right way round', () => {
  assert.deepEqual(cleanSavedReport({ module: 'leads', kind: 'source', name: ' Sources ', from: '2026-11-01', to: '2026-11-15', brand: 'KERALA' }), {
    doc: { module: 'leads', kind: 'source', name: 'Sources', from: '2026-11-01', to: '2026-11-15', brand: 'kerala' },
  });
  assert.equal(cleanSavedReport({ module: 'leads', kind: 'x', from: '2026-11-01', to: '2026-11-01' }).doc.brand, 'all');
  assert.match(cleanSavedReport({ module: 'hr', kind: 'x', from: '2026-11-01', to: '2026-11-02' }).error, /module/);
  assert.match(cleanSavedReport({ module: 'team', from: '2026-11-01', to: '2026-11-02' }).error, /kind/);
  assert.match(cleanSavedReport({ module: 'team', kind: 'x', from: '2026-11-05', to: '2026-11-02' }).error, /from first/);
});
