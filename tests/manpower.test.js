import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateRequest,
  parseDay,
  overlaps,
  loadOf,
  levelFor,
  coveredSeats,
  seatsLeft,
  requestStatus,
  needsRelease,
  budgetRoom,
  canHandleManpower,
  isHrDepartment,
  mayRaise,
  MAX_HEADCOUNT,
} from '../utils/manpower.js';

const day = (s) => parseDay(s);
const ok = { roleTitle: 'UI designer', headcount: 2, startDate: '2026-12-01', endDate: '2027-02-28', reason: 'Scope grew' };

describe('who is HR', () => {
  test('the HR department, under either name', () => {
    assert.equal(isHrDepartment('HR'), true);
    assert.equal(isHrDepartment(' Human Resources '), true);
    assert.equal(isHrDepartment('hr'), true);
  });
  test('no other department', () => {
    for (const d of ['IT', 'Finance', 'Marketing', '', undefined, 'HRM']) assert.equal(isHrDepartment(d), false, String(d));
  });
  test('HR people and administrators may handle requests; nobody else', () => {
    assert.equal(canHandleManpower({ role: 'crm', deptName: 'HR' }), true);
    assert.equal(canHandleManpower({ role: 'admin', deptName: '' }), true);
    assert.equal(canHandleManpower({ role: ' Admin ', deptName: 'IT' }), true);
    assert.equal(canHandleManpower({ role: 'finance_head', deptName: 'Finance' }), false);
    assert.equal(canHandleManpower({ role: 'manager', deptName: '' }), false);
  });
  test('whoever runs the project, or leads a department on it, may ask', () => {
    assert.equal(mayRaise({ manage: true, leadsDepartment: false }), true);
    assert.equal(mayRaise({ manage: false, leadsDepartment: true }), true);
    assert.equal(mayRaise({ manage: false, leadsDepartment: false }), false);
  });
});

describe('a day', () => {
  test('a date written as text keeps the day it says', () => {
    assert.equal(day('2026-11-20').toISOString(), '2026-11-20T00:00:00.000Z');
    assert.equal(day('2026-11-20T23:30:00+05:30').toISOString(), '2026-11-20T00:00:00.000Z');
  });
  test('a Date is read by its stored (UTC) day', () => {
    assert.equal(day(new Date(Date.UTC(2026, 10, 20))).toISOString(), '2026-11-20T00:00:00.000Z');
  });
  test('not a day', () => {
    for (const v of [undefined, null, '', 'soon', '2026-02-31', '2026-13-01', new Date('x')]) assert.equal(day(v), null, String(v));
  });
});

describe('a request as filed', () => {
  test('a good one is tidied', () => {
    const r = validateRequest({ ...ok, roleTitle: '  UI designer ', skills: ' Figma ', allocationPercent: '50', urgency: 'urgent', estimatedCost: '1,20,000' });
    assert.equal(r.error, undefined);
    assert.equal(r.roleTitle, 'UI designer');
    assert.equal(r.skills, 'Figma');
    assert.equal(r.headcount, 2);
    assert.equal(r.allocationPercent, 50);
    assert.equal(r.urgency, 'urgent');
    assert.equal(r.estimatedCost, 120000);
    assert.equal(r.startDate.toISOString(), '2026-12-01T00:00:00.000Z');
  });
  test('defaults: one person, all of their time, normal urgency, no cost', () => {
    const r = validateRequest({ roleTitle: 'Editor', startDate: '2026-12-01', endDate: '2026-12-31', reason: 'a shoot' });
    assert.equal(r.headcount, 1);
    assert.equal(r.allocationPercent, 100);
    assert.equal(r.urgency, 'normal');
    assert.equal(r.estimatedCost, 0);
  });
  test('what is missing is named', () => {
    assert.equal(validateRequest({ ...ok, roleTitle: ' ' }).code, 'ROLE_REQUIRED');
    assert.equal(validateRequest({ ...ok, reason: 'x' }).code, 'REASON_REQUIRED');
    assert.equal(validateRequest({ ...ok, startDate: undefined }).code, 'DATES_REQUIRED');
    assert.equal(validateRequest({ ...ok, endDate: 'soon' }).code, 'DATES_REQUIRED');
  });
  test('how many: a whole number from 1 to the limit', () => {
    for (const n of [0, -1, 1.5, 'many', MAX_HEADCOUNT + 1]) assert.equal(validateRequest({ ...ok, headcount: n }).code, 'HEADCOUNT_INVALID', String(n));
    assert.equal(validateRequest({ ...ok, headcount: MAX_HEADCOUNT }).headcount, MAX_HEADCOUNT);
  });
  test('the dates must run forwards, and not for more than five years', () => {
    assert.equal(validateRequest({ ...ok, startDate: '2026-12-10', endDate: '2026-12-01' }).code, 'DATES_INVALID');
    assert.equal(validateRequest({ ...ok, startDate: '2026-12-01', endDate: '2026-12-01' }).error, undefined, 'a single day is fine');
    assert.equal(validateRequest({ ...ok, startDate: '2026-01-01', endDate: '2033-01-01' }).code, 'DATES_INVALID');
  });
  test('how much of their time: 5% to 100%', () => {
    for (const p of [0, 4, 101, 50.5, 'half']) assert.equal(validateRequest({ ...ok, allocationPercent: p }).code, 'ALLOCATION_INVALID', String(p));
    assert.equal(validateRequest({ ...ok, allocationPercent: 5 }).allocationPercent, 5);
    assert.equal(validateRequest({ ...ok, allocationPercent: 100 }).allocationPercent, 100);
  });
  test('urgency is normal or urgent', () => {
    assert.equal(validateRequest({ ...ok, urgency: 'asap' }).code, 'URGENCY_INVALID');
  });
  test('a cost that is not a number is refused; none at all is zero', () => {
    assert.equal(validateRequest({ ...ok, estimatedCost: 'lots' }).code, 'COST_INVALID');
    assert.equal(validateRequest({ ...ok, estimatedCost: -5 }).code, 'COST_INVALID');
    assert.equal(validateRequest({ ...ok, estimatedCost: '' }).estimatedCost, 0);
  });
  test('long text is cut, not refused', () => {
    const r = validateRequest({ ...ok, roleTitle: 'x'.repeat(200), skills: 'y'.repeat(900), reason: 'z'.repeat(2000) });
    assert.equal(r.roleTitle.length, 80);
    assert.equal(r.skills.length, 300);
    assert.equal(r.reason.length, 500);
  });
});

describe('overlapping days, and how busy someone is', () => {
  const span = (a, b) => ({ from: day(a), to: day(b) });
  test('stretches overlap when they share a day; touching on one day counts', () => {
    assert.equal(overlaps(span('2026-12-01', '2026-12-10'), span('2026-12-10', '2026-12-20')), true);
    assert.equal(overlaps(span('2026-12-01', '2026-12-09'), span('2026-12-10', '2026-12-20')), false);
    assert.equal(overlaps(span('2026-12-01', '2027-03-01'), span('2026-12-10', '2026-12-20')), true);
  });
  test('a stretch with no dates overlaps nothing', () => {
    assert.equal(overlaps({ from: null, to: null }, span('2026-12-01', '2026-12-10')), false);
  });
  test('the load is what overlaps the window, added up; an ended allocation does not count', () => {
    const allocs = [
      { percent: 50, from: day('2026-12-01'), to: day('2026-12-31') },
      { percent: 30, from: day('2026-12-15'), to: day('2027-01-15') },
      { percent: 40, from: day('2027-03-01'), to: day('2027-03-31') },
      { percent: 60, from: day('2026-12-01'), to: day('2026-12-31'), status: 'ended' },
    ];
    assert.equal(loadOf(allocs, day('2026-12-10'), day('2026-12-20')), 80);
    assert.equal(loadOf(allocs, day('2027-02-01'), day('2027-02-10')), 0);
    assert.equal(loadOf([], day('2026-12-10'), day('2026-12-20')), 0);
  });
  test('free, tight, busy — judged with the new time added', () => {
    assert.equal(levelFor({ load: 0, add: 50 }), 'free');
    assert.equal(levelFor({ load: 20, add: 40 }), 'free');
    assert.equal(levelFor({ load: 30, add: 40 }), 'tight', '70% is the first tight');
    assert.equal(levelFor({ load: 50, add: 50 }), 'tight', 'exactly 100% fits');
    assert.equal(levelFor({ load: 60, add: 50 }), 'busy');
  });
  test('on leave is busy whatever the load', () => {
    assert.equal(levelFor({ load: 0, add: 10, onLeave: true }), 'busy');
  });
});

describe('seats and where a request stands', () => {
  const line = (state, seats = 1) => ({ state, seats });
  test('a refused seat is open again', () => {
    assert.equal(coveredSeats([line('assigned'), line('refused')]), 1);
    assert.equal(seatsLeft(3, [line('assigned'), line('hiring', 2)]), 0);
    assert.equal(seatsLeft(3, [line('assigned'), line('refused')]), 2);
  });
  test('seats left never go below zero', () => {
    assert.equal(seatsLeft(1, [line('assigned'), line('assigned')]), 0);
  });
  test('submitted until HR touches it', () => {
    assert.equal(requestStatus({ status: 'submitted', headcount: 2, lines: [] }), 'submitted');
  });
  test('in progress while any seat is waiting, or not all are covered', () => {
    assert.equal(requestStatus({ headcount: 2, lines: [line('assigned')] }), 'in_progress');
    assert.equal(requestStatus({ headcount: 2, lines: [line('assigned'), line('awaiting_release')] }), 'in_progress');
    assert.equal(requestStatus({ headcount: 2, lines: [line('assigned'), line('hiring')] }), 'in_progress', 'a hire is not done until they join');
    assert.equal(requestStatus({ headcount: 1, lines: [line('refused')] }), 'in_progress');
  });
  test('fulfilled once every seat is filled and nothing waits', () => {
    assert.equal(requestStatus({ headcount: 2, lines: [line('assigned'), line('assigned')] }), 'fulfilled');
    assert.equal(requestStatus({ headcount: 2, lines: [line('assigned', 2)] }), 'fulfilled');
    assert.equal(requestStatus({ headcount: 1, lines: [line('refused'), line('assigned')] }), 'fulfilled');
  });
  test('declined and cancelled stay as they are', () => {
    assert.equal(requestStatus({ status: 'declined', headcount: 1, lines: [line('assigned')] }), 'declined');
    assert.equal(requestStatus({ status: 'cancelled', headcount: 1, lines: [] }), 'cancelled');
  });
});

describe('who has to let a person go', () => {
  test('someone from a department not on the project needs their head\'s release', () => {
    assert.equal(needsRelease({ employeeDept: 'Sales', projectDepartments: ['Marketing', 'IT'] }), true);
  });
  test('not someone from a department already on it (any capitalisation)', () => {
    assert.equal(needsRelease({ employeeDept: ' it ', projectDepartments: ['Marketing', 'IT'] }), false);
  });
  test('someone with no department is not held up', () => {
    assert.equal(needsRelease({ employeeDept: '', projectDepartments: ['IT'] }), false);
  });
});

describe('is there room in the budget', () => {
  test('within what is left', () => {
    assert.deepEqual(budgetRoom({ limit: 100000, used: 30000, cost: 50000 }), { short: false, shortfall: 0, available: 70000 });
  });
  test('exactly what is left fits; a rupee more does not, and says by how much', () => {
    assert.equal(budgetRoom({ limit: 100000, used: 30000, cost: 70000 }).short, false);
    assert.deepEqual(budgetRoom({ limit: 100000, used: 30000, cost: 70001 }), { short: true, shortfall: 1, available: 70000 });
  });
  test('already past the limit: all of it is short', () => {
    const r = budgetRoom({ limit: 100000, used: 110000, cost: 5000 });
    assert.equal(r.short, true);
    assert.equal(r.shortfall, 5000);
  });
  test('no approved budget at all: any cost is short', () => {
    assert.deepEqual(budgetRoom({ limit: 0, used: 0, cost: 1000 }), { short: true, shortfall: 1000, available: 0 });
  });
  test('no cost, no problem — even with no budget', () => {
    assert.equal(budgetRoom({ limit: 0, used: 0, cost: 0 }).short, false);
  });
});
