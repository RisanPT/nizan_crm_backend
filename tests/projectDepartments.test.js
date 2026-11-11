// node --test tests/projectDepartments.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { departmentsOf, activeDepartmentNames, hasDepartment, normalizeDepartments } from '../utils/projectDepartments.js';

const NOW = new Date('2026-10-30T10:00:00Z');
const names = (r) => r.departments.map((d) => [d.name, d.role, d.status]);

test('a project from before departments existed: its one department is the accepted owner', () => {
  assert.deepEqual(departmentsOf({ targetDepartment: 'IT' }), [{ name: 'IT', role: 'owner', leadId: null, status: 'accepted' }]);
  assert.deepEqual(departmentsOf({ targetDepartment: '' }), []);
  assert.deepEqual(departmentsOf({}), []);
  assert.deepEqual(activeDepartmentNames({ targetDepartment: 'IT' }), ['IT']);
});

test('adding departments: owner first and accepted; participant departments directly included', () => {
  const r = normalizeDepartments({ requested: ['Marketing', { name: 'HR', leadId: 'e1' }], existing: [], ownerName: 'IT', now: NOW });
  assert.deepEqual(names(r), [['IT', 'owner', 'accepted'], ['Marketing', 'participant', 'accepted'], ['HR', 'participant', 'accepted']]);
  assert.deepEqual(r.added, ['Marketing', 'HR']);
  assert.deepEqual(r.removed, []);
  assert.equal(r.departments[2].leadId, 'e1');
});

test('adding departments includes them directly without invitation approval delay', () => {
  const r = normalizeDepartments({ requested: ['Marketing', 'HR'], existing: [], ownerName: 'IT', actorDept: 'marketing', now: NOW });
  assert.deepEqual(names(r), [['IT', 'owner', 'accepted'], ['Marketing', 'participant', 'accepted'], ['HR', 'participant', 'accepted']]);
  assert.deepEqual(r.added, ['Marketing', 'HR']);
});

test('the owner in the requested list is ignored; duplicates and blanks are dropped (case-insensitive)', () => {
  const r = normalizeDepartments({ requested: ['IT', 'hr', 'HR', ' ', '', { name: '' }], existing: [], ownerName: 'IT', now: NOW });
  assert.deepEqual(names(r), [['IT', 'owner', 'accepted'], ['hr', 'participant', 'accepted']]);
});

test('editing keeps each department\'s inclusion; removing one is reported', () => {
  const existing = [
    { name: 'IT', role: 'owner', status: 'accepted' },
    { name: 'Marketing', role: 'participant', status: 'accepted', respondedAt: NOW },
    { name: 'HR', role: 'participant', status: 'accepted' },
  ];
  const r = normalizeDepartments({ requested: ['Marketing', 'Finance'], existing, ownerName: 'IT', now: NOW });
  assert.deepEqual(names(r), [['IT', 'owner', 'accepted'], ['Marketing', 'participant', 'accepted'], ['Finance', 'participant', 'accepted']]);
  assert.deepEqual(r.added, ['Finance']);
  assert.deepEqual(r.removed, ['HR']);
  assert.equal(r.departments[1].respondedAt, NOW, 'Marketing keeps its acceptance');
});

test('asking a department that declined re-includes it in the project', () => {
  const existing = [{ name: 'IT', role: 'owner', status: 'accepted' }, { name: 'HR', role: 'participant', status: 'declined', respondedAt: NOW }];
  const r = normalizeDepartments({ requested: ['HR'], existing, ownerName: 'IT', now: NOW });
  assert.deepEqual(names(r), [['IT', 'owner', 'accepted'], ['HR', 'participant', 'accepted']]);
  assert.deepEqual(r.added, ['HR']);
});

test('a declined department is not on the project', () => {
  const p = { departments: [{ name: 'IT', role: 'owner', status: 'accepted' }, { name: 'HR', role: 'participant', status: 'declined' }, { name: 'Marketing', status: 'invited' }] };
  assert.deepEqual(activeDepartmentNames(p), ['IT', 'Marketing']);
  assert.equal(hasDepartment(p, 'marketing'), true);
  assert.equal(hasDepartment(p, 'HR'), false);
});

test('changing the owner: the old owner can stay as a participant', () => {
  const existing = [{ name: 'IT', role: 'owner', status: 'accepted' }, { name: 'Marketing', role: 'participant', status: 'accepted' }];
  const r = normalizeDepartments({ requested: ['IT'], existing, ownerName: 'Marketing', now: NOW });
  assert.equal(r.departments[0].name, 'Marketing');
  assert.equal(r.departments[0].role, 'owner');
  assert.equal(r.departments[1].name, 'IT');
  assert.equal(r.departments[1].role, 'participant');
});
