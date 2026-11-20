// Who is on the CRM team and who leads it (utils/crmAccess.js), and who may appoint the CRM Head
// (utils/userAccess.js): node --test tests/crmAccess.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { CRM_HEAD_ROLE, canAssignCrmWork, crmViewerOf, isCrmHead, isCrmRole, seesWholeCrmTeam } from '../utils/crmAccess.js';
import { authorizeUserChange, delegatedRoles, mayGiveRole, mayMarkDepartmentHead, roleGrantRefusal, roleGroupOf } from '../utils/userAccess.js';

const u = (role, extra = {}) => ({ _id: `${role}-id`, role, ...extra });

test('the CRM team: crm and the CRM Head, whatever the case or spacing — nobody else', () => {
  for (const role of ['crm', 'CRM', ' crm_manager ', CRM_HEAD_ROLE]) assert.equal(isCrmRole(u(role)), true, role);
  for (const role of ['sales', 'sales_manager', 'accounts', 'artist', 'admin', 'manager', 'ceo', '', undefined]) assert.equal(isCrmRole(u(role)), false, String(role));
  assert.equal(isCrmRole(null), false);
  assert.equal(roleGroupOf('crm_manager'), 'crm');
  assert.equal(roleGroupOf('nope'), '');
});

test('the CRM Head: the crm_manager role, or a crm login marked as the department head', () => {
  assert.equal(isCrmHead(u('crm_manager')), true);
  assert.equal(isCrmHead(u('crm', { isDepartmentHead: true })), true);
  assert.equal(isCrmHead(u('crm')), false);
  assert.equal(isCrmHead(u('crm', { isDepartmentHead: 'yes' })), false, 'only a real true');
  assert.equal(isCrmHead(u('sales', { isDepartmentHead: true })), false, 'the head of ANOTHER department is not the CRM Head');
});

test('what each login is to the CRM screens', () => {
  assert.equal(crmViewerOf(u('admin')), 'admin');
  assert.equal(crmViewerOf(u('manager')), 'admin');
  assert.equal(crmViewerOf(u('ceo')), 'leadership');
  assert.equal(crmViewerOf(u('executive_director')), 'leadership');
  assert.equal(crmViewerOf(u('crm_manager')), 'head');
  assert.equal(crmViewerOf(u('crm', { isDepartmentHead: true })), 'head');
  assert.equal(crmViewerOf(u('crm')), 'member');
  for (const role of ['sales', 'accounts', 'artist', 'driver', '']) assert.equal(crmViewerOf(u(role)), 'none', role);
  assert.equal(crmViewerOf(null), 'none');
});

test('who sees the whole team, and who may hand out work (leadership reads only)', () => {
  assert.deepEqual(['admin', 'head', 'leadership', 'member', 'none'].map(seesWholeCrmTeam), [true, true, true, false, false]);
  assert.deepEqual(['admin', 'head', 'leadership', 'member', 'none'].map(canAssignCrmWork), [true, true, false, false, false]);
});

test('the CRM Head is appointed by management — never by another head', () => {
  for (const who of [u('admin'), u('manager')]) assert.equal(mayGiveRole(who, 'crm_manager'), true, who.role);
  for (const who of [u('crm_manager'), u('crm', { isDepartmentHead: true }), u('sales_manager'), u('fleet_manager'), u('crm')]) {
    assert.equal(mayGiveRole(who, 'crm_manager'), false, who.role);
    assert.match(roleGrantRefusal(who, 'crm_manager'), /administrator or a manager can appoint a department head/);
  }
  assert.equal(roleGrantRefusal(u('crm_manager'), 'crm'), null, 'a CRM member the head may create');
  assert.match(roleGrantRefusal(u('manager'), 'admin'), /Only an administrator can create an admin/);
});

test('a CRM Head manages CRM members — but cannot promote one to head, nor touch another head', () => {
  const head = u('crm_manager');
  assert.deepEqual(delegatedRoles('crm_manager'), ['crm']);
  assert.equal(authorizeUserChange(head, u('crm', { _id: 'm1' })).ok, true);
  const promote = authorizeUserChange(head, u('crm', { _id: 'm1' }), { nextRole: 'crm_manager' });
  assert.equal(promote.ok, false);
  assert.match(promote.message, /appoint a department head/);
  assert.equal(authorizeUserChange(head, u('crm_manager', { _id: 'h2' })).ok, false, 'another head is not on their team');
  assert.equal(authorizeUserChange(u('manager'), u('crm', { _id: 'm1' }), { nextRole: 'crm_manager' }).ok, true, 'a manager may appoint');
  // a head with no team of their own (the flag on an artist) cannot appoint a head either
  assert.equal(authorizeUserChange(u('artist', { isDepartmentHead: true, _id: 'x' }), u('artist', { _id: 'y', managedBy: 'x' }), { nextRole: 'crm_manager' }).ok, false);
});

test('only management marks someone as a department head', () => {
  for (const who of [u('admin'), u('manager')]) assert.equal(mayMarkDepartmentHead(who), true, who.role);
  for (const who of [u('crm_manager'), u('sales_manager'), u('crm', { isDepartmentHead: true }), u('crm'), undefined]) assert.equal(mayMarkDepartmentHead(who), false, String(who?.role));
});
