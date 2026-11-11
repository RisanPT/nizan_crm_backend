// Pure unit tests: node --test tests/ceoProjectAccess.test.js
// The CEO sees every project and may decide on a proposal — and cannot plan, add or change anything on one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { accessSummary } from '../utils/projectAccess.js';

const project = (extra = {}) => ({ status: 'planning', targetDepartment: 'Management', departments: [{ name: 'Management', role: 'owner', status: 'accepted' }], members: [], editMode: 'managed', ...extra });
const ctx = (extra = {}) => ({ full: false, empId: '', isHead: false, deptName: '', viewOnly: false, ...extra });

test('an admin (full access) manages, adds and edits', () => {
  const a = accessSummary(project(), ctx({ full: true }));
  assert.equal(a.canManage, true);
  assert.equal(a.canCreateTasks, true);
  assert.equal(a.canEditAllTasks, true);
  assert.equal(a.role, 'admin');
});

test('the CEO sees it all but plans nothing: no managing, no adding, no editing, no lead rights', () => {
  const a = accessSummary(project(), ctx({ full: true, viewOnly: true }));
  assert.equal(a.canManage, false);
  assert.equal(a.canCreateTasks, false);
  assert.equal(a.canEditAllTasks, false);
  assert.deepEqual(a.leadDepartments, []);
  assert.equal(a.role, 'viewer');
});

test('…even on a project anyone may edit — the app must not offer the CEO its edit controls', () => {
  const a = accessSummary(project({ editMode: 'open' }), ctx({ full: true, viewOnly: true }));
  assert.equal(a.canCreateTasks, false);
  assert.equal(a.canEditAllTasks, false);
  assert.equal(a.editMode, 'managed');
  // while an admin on the same project still can
  const admin = accessSummary(project({ editMode: 'open' }), ctx({ full: true }));
  assert.equal(admin.canCreateTasks, true);
});

test('the CEO decides on a proposal — that is what the role is for', () => {
  const a = accessSummary(project({ status: 'proposed' }), ctx({ full: true, viewOnly: true }));
  assert.equal(a.canDecide, true);
});

test('…and only on a proposal', () => {
  assert.equal(accessSummary(project({ status: 'active' }), ctx({ full: true, viewOnly: true })).canDecide, false);
  assert.equal(accessSummary(project({ status: 'completed' }), ctx({ full: true, viewOnly: true })).canDecide, false);
});

test('someone who is not full access cannot decide, CEO flag or not', () => {
  assert.equal(accessSummary(project({ status: 'proposed' }), ctx()).canDecide, false);
});
