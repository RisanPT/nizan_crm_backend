import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idList, staffOf, inDepartment, peopleChange, checkTeam, teamActivityLines } from '../utils/projectPeople.js';

// Who is on a project (its manager and team) and what a change to them may be.

const e = (id, name, department, { category = '', status = 'active' } = {}) => ({ _id: id, name, department, category, status });
const staff = [
  e('m1', 'Mira', 'Marketing'),
  e('a2', 'Arun', 'Marketing'),
  e('c4', 'Chitra', 'Marketing'),
  e('b3', 'Bindu', 'Finance'),
  e('d5', 'Dev', 'HR'),
  e('o6', 'Old Hand', 'Marketing', { status: 'inactive' }),
  e('k7', 'Kiran', '', { category: 'marketing' }),
];
const ids = (list) => list.map((x) => x._id);

test('ids: each once, blanks and objects handled', () => {
  assert.deepEqual(idList(['a', { _id: 'b' }, 'a', '', null, ' c ']), ['a', 'b', 'c']);
  assert.deepEqual(idList(undefined), []);
});

test('a department\'s people: active, by department or category (any case); nobody tagged → everyone active', () => {
  assert.deepEqual(ids(staffOf(staff, 'marketing')), ['m1', 'a2', 'c4', 'k7'], 'inactive Old Hand left out; Kiran by category');
  assert.deepEqual(ids(staffOf(staff, 'Accounts')), ['m1', 'a2', 'c4', 'b3', 'd5', 'k7'], 'nobody in Accounts → everyone active');
  assert.equal(inDepartment(staff[3], 'FINANCE'), true);
  assert.equal(inDepartment(staff[3], ''), false);
});

test('a change: who joins and who is taken off, the manager counted with the team', () => {
  const c = peopleChange({ before: { managerId: 'm1', members: ['a2', 'c4'] }, after: { managerId: 'a2', members: ['m1', 'b3', 'a2'] } });
  assert.equal(c.managerChanged, true);
  assert.deepEqual([c.from, c.to], ['m1', 'a2']);
  assert.deepEqual(c.added, ['b3']);
  assert.deepEqual(c.removed, ['c4'], 'Mira stays (as a member), Arun stays (as manager)');
  assert.deepEqual(c.members, ['m1', 'b3'], 'the manager is never also a member');
  const same = peopleChange({ before: { managerId: 'm1', members: ['a2'] }, after: { managerId: 'm1', members: ['a2', 'm1'] } });
  assert.deepEqual([same.managerChanged, same.added, same.removed, same.members], [false, [], [], ['a2']]);
});

const check = (change, extra = {}) =>
  checkTeam({ employees: staff, owner: 'Marketing', departments: ['Marketing', 'Finance'], change: peopleChange(change), ...extra });

test('the manager comes from the owning department and is an active employee', () => {
  assert.equal(check({ before: { managerId: 'm1' }, after: { managerId: 'a2' } }).ok, true);
  assert.equal(check({ before: { managerId: 'm1' }, after: { managerId: 'b3' } }).code, 'TEAM_MANAGER_OUTSIDE');
  assert.match(check({ before: { managerId: 'm1' }, after: { managerId: 'b3' } }).error, /Bindu is not in Marketing/);
  assert.equal(check({ before: { managerId: 'm1' }, after: { managerId: 'o6' } }).code, 'TEAM_INACTIVE');
  assert.equal(check({ before: { managerId: 'm1' }, after: { managerId: 'zz' } }).code, 'TEAM_UNKNOWN');
  assert.equal(check({ before: { managerId: 'm1' }, after: { managerId: '' } }).code, 'TEAM_MANAGER_REQUIRED');
  // a staff member proposing manages their own proposal, whatever their department
  assert.equal(check({ before: {}, after: { managerId: 'd5' } }, { proposerId: 'd5' }).ok, true);
  // a manager who is no longer active is not an error as long as they are not changed
  assert.equal(check({ before: { managerId: 'o6', members: [] }, after: { managerId: 'o6', members: ['a2'] } }).ok, true);
});

test('those who join are active and from the departments on the project; those already on it are not checked again', () => {
  assert.equal(check({ before: { managerId: 'm1', members: [] }, after: { managerId: 'm1', members: ['a2', 'b3'] } }).ok, true);
  const hr = check({ before: { managerId: 'm1', members: [] }, after: { managerId: 'm1', members: ['d5'] } });
  assert.equal(hr.code, 'TEAM_MEMBER_OUTSIDE');
  assert.match(hr.error, /Dev is not in the departments on this project \(Marketing and Finance\)/);
  assert.equal(check({ before: { managerId: 'm1', members: [] }, after: { managerId: 'm1', members: ['o6'] } }).code, 'TEAM_INACTIVE');
  assert.equal(check({ before: { managerId: 'm1', members: ['d5', 'o6'] }, after: { managerId: 'm1', members: ['d5', 'o6', 'a2'] } }).ok, true, 'kept as they were');
});

test('a department lead (not running the project) adds and takes off their own department\'s people only, never the manager', () => {
  const lead = { leadOf: ['Finance'] };
  assert.equal(check({ before: { managerId: 'm1', members: ['a2'] }, after: { managerId: 'm1', members: ['a2', 'b3'] } }, lead).ok, true);
  const other = check({ before: { managerId: 'm1', members: ['a2'] }, after: { managerId: 'm1', members: ['b3'] } }, lead);
  assert.equal(other.code, 'TEAM_NOT_YOUR_DEPARTMENT');
  assert.match(other.error, /You lead Finance: you can add or take off its people only\. Arun is not in Finance\./);
  assert.equal(check({ before: { managerId: 'm1' }, after: { managerId: 'a2' } }, lead).code, 'TEAM_MANAGER_LOCKED');
  // no "everyone" fallback for a lead: a department with nobody tagged gives them nobody
  assert.equal(check({ before: { managerId: 'm1', members: [] }, after: { managerId: 'm1', members: ['a2'] } }, { leadOf: ['Accounts'] }).code, 'TEAM_NOT_YOUR_DEPARTMENT');
});

test('the activity lines say who manages, who joined, who was taken off and what happened to their work', () => {
  const names = { m1: 'Mira', a2: 'Arun', b3: 'Bindu', c4: 'Chitra', d5: 'Dev' };
  const of = (id) => names[id];
  const c = peopleChange({ before: { managerId: 'm1', members: ['c4', 'd5'] }, after: { managerId: 'a2', members: ['m1', 'b3'] } });
  assert.deepEqual(teamActivityLines(c, of, { unassigned: 3, ended: 1 }), [
    'Project manager: Mira → Arun',
    'Bindu joined the team',
    'Chitra and Dev taken off the team (3 open tasks unassigned, 1 HR placement ended)',
  ]);
  assert.deepEqual(teamActivityLines(peopleChange({ before: {}, after: { managerId: 'm1', members: ['a2', 'b3', 'c4'] } }), of), [
    'Mira manages the project',
    'Arun, Bindu and Chitra joined the team',
  ]);
});
