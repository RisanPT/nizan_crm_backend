// Pure unit tests: node --test tests/userAccess.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { requesterKind, canManageUsers, authorizeUserChange, delegatedRoles, mayGiveRole } from '../utils/userAccess.js';

const u = (id, role, extra = {}) => ({ _id: id, role, ...extra });
const admin = u('A', 'admin');
const manager = u('M', 'manager');
const artist = u('R', 'artist');
const fleet = u('F', 'fleet_manager');
const salesHead = u('S', 'sales', { isDepartmentHead: true });

const ok = (requester, target, opts) => authorizeUserChange(requester, target, opts).ok;

test('who counts as what is the test createUser uses', () => {
  assert.deepEqual(requesterKind(admin), { admin: true, full: true, head: false });
  assert.deepEqual(requesterKind(manager), { admin: false, full: true, head: false });
  assert.equal(requesterKind(fleet).head, true); // *_manager
  assert.equal(requesterKind(u('x', 'marketing_admin')).head, true); // *_admin
  assert.equal(requesterKind(salesHead).head, true); // the flag
  assert.deepEqual(requesterKind(artist), { admin: false, full: false, head: false });
  assert.deepEqual(requesterKind(undefined), { admin: false, full: false, head: false });
  assert.equal(requesterKind(u('x', ' ADMIN ')).admin, true);
});

test('an ordinary user manages nobody, not even themselves', () => {
  assert.equal(canManageUsers(artist), false);
  assert.equal(ok(artist, u('X', 'artist')), false);
  assert.equal(ok(artist, artist), false);
  assert.equal(ok(artist, u('X', 'artist'), { nextRole: 'admin' }), false);
  assert.equal(ok(u('R', 'artist', { isDepartmentHead: false }), u('X', 'driver')), false);
});

test('an admin may do anything, including giving the admin / manager role and editing another admin', () => {
  assert.equal(ok(admin, u('X', 'artist'), { nextRole: 'admin' }), true);
  assert.equal(ok(admin, u('X', 'artist'), { nextRole: 'manager' }), true);
  assert.equal(ok(admin, u('X', 'admin')), true);
  assert.equal(ok(admin, u('X', 'manager'), { nextRole: 'artist' }), true);
});

test('a manager has full access except over admin accounts and the admin / manager roles', () => {
  assert.equal(ok(manager, u('X', 'artist'), { nextRole: 'accounts' }), true);
  assert.equal(ok(manager, u('X', 'driver')), true);
  assert.equal(ok(manager, u('X', 'artist'), { nextRole: 'admin' }), false);
  assert.equal(ok(manager, u('X', 'artist'), { nextRole: 'manager' }), false);
  assert.equal(ok(manager, u('X', 'artist'), { nextRole: ' ADMIN ' }), false);
  assert.equal(ok(manager, u('X', 'admin')), false);
  assert.equal(ok(manager, u('X', 'admin'), { nextRole: 'artist' }), false);
});

test('re-sending a role that is not changing is not a promotion (the app sends the role on every save)', () => {
  assert.equal(ok(manager, u('X', 'manager'), { nextRole: 'manager' }), true);
  assert.equal(ok(manager, manager, { nextRole: 'manager' }), true);
  assert.equal(ok(salesHead, u('X', 'sales', { managedBy: 'S' }), { nextRole: 'sales' }), true);
});

test('a department head manages users they created, never an admin / manager account', () => {
  assert.equal(ok(salesHead, u('X', 'artist', { managedBy: 'S' })), true);
  assert.equal(ok(salesHead, u('X', 'artist', { managedBy: 'OTHER' })), false);
  assert.equal(ok(salesHead, u('X', 'artist', { managedBy: null })), false);
  assert.equal(ok(salesHead, u('X', 'artist')), false);
  assert.equal(ok(salesHead, u('X', 'admin', { managedBy: 'S' })), false);
  assert.equal(ok(salesHead, u('X', 'manager', { managedBy: 'S' })), false);
});

test('a department head also manages the roles their role delegates (what the My Team screen lists)', () => {
  assert.deepEqual(delegatedRoles('sales'), ['sales', 'sales_manager', 'sales_executive']);
  assert.deepEqual(delegatedRoles('Sales_Manager'), delegatedRoles('sales'));
  assert.deepEqual(delegatedRoles('finance_head'), delegatedRoles('accounts'));
  assert.deepEqual(delegatedRoles('artist'), []);
  assert.equal(ok(salesHead, u('X', 'sales_executive', { managedBy: null })), true);
  assert.equal(ok(salesHead, u('X', 'accounts', { managedBy: null })), false);
});

test('a department head cannot give the admin / manager role, or a role outside what their role delegates', () => {
  const mine = u('X', 'sales', { managedBy: 'S' });
  assert.equal(ok(salesHead, mine, { nextRole: 'admin' }), false);
  assert.equal(ok(salesHead, mine, { nextRole: 'manager' }), false);
  assert.equal(ok(salesHead, mine, { nextRole: 'sales_executive' }), true);
  assert.equal(ok(salesHead, mine, { nextRole: 'accounts' }), false);
});

test('a head whose role delegates nothing may assign any role except admin / manager', () => {
  const head = u('H', 'artist', { isDepartmentHead: true });
  const mine = u('X', 'artist', { managedBy: 'H' });
  assert.equal(ok(head, mine, { nextRole: 'accounts' }), true);
  assert.equal(ok(head, mine, { nextRole: 'admin' }), false);
});

test('a department head cannot change their own account', () => {
  assert.equal(ok(salesHead, salesHead), false); // sales is in their own delegated roles — still refused
  assert.equal(ok(salesHead, salesHead, { nextRole: 'sales' }), false);
});

test('a fleet manager manages driver accounts only, and keeps them drivers', () => {
  assert.equal(ok(fleet, u('X', 'driver')), true);
  assert.equal(ok(fleet, u('X', 'driver'), { nextRole: 'driver' }), true);
  assert.equal(ok(fleet, u('X', 'driver'), { nextRole: 'artist' }), false);
  assert.equal(ok(fleet, u('X', 'driver'), { nextRole: 'admin' }), false);
  assert.equal(ok(fleet, u('X', 'admin')), false);
  assert.equal(ok(fleet, u('X', 'manager')), false);
  assert.equal(ok(fleet, u('X', 'artist')), false);
  assert.equal(ok(fleet, u('X', 'artist', { managedBy: 'F' })), true); // one they created themselves
});

test('ids may be ObjectId-like', () => {
  const oid = (s) => ({ toString: () => s, _id: undefined });
  assert.equal(ok(u(oid('S'), 'sales', { isDepartmentHead: true }), u(oid('X'), 'artist', { managedBy: oid('S') })), true);
  assert.equal(ok(u(oid('S'), 'sales', { isDepartmentHead: true }), u(oid('X'), 'artist', { managedBy: oid('Q') })), false);
});

// ── the CEO account ──────────────────────────────────────────────────────────

test('only an administrator may create, change or remove the CEO account — a manager may not', () => {
  const ceo = u('C', 'ceo');
  assert.equal(ok(admin, ceo), true);
  assert.equal(ok(manager, ceo), false);
  assert.equal(authorizeUserChange(manager, ceo).message, 'Only an administrator can change the CEO account.');
  assert.equal(ok(salesHead, ceo), false);
  assert.equal(ok(artist, ceo), false);
});

test('only an administrator may give someone the CEO role', () => {
  const target = u('X', 'artist');
  assert.equal(ok(admin, target, { nextRole: 'ceo' }), true);
  assert.equal(ok(manager, target, { nextRole: 'ceo' }), false);
  assert.match(authorizeUserChange(manager, target, { nextRole: 'ceo' }).message, /administrator can give the admin, manager or CEO role/);
  assert.equal(ok(salesHead, target, { nextRole: 'ceo' }), false);
  // leaving a CEO as CEO (the app re-sends the unchanged role on every save) is not a change of role
  assert.equal(ok(admin, u('C', 'ceo'), { nextRole: 'ceo' }), true);
});

test('mayGiveRole: creating or provisioning a CEO is for an administrator only; every other role is unaffected', () => {
  assert.equal(mayGiveRole(admin, 'ceo'), true);
  assert.equal(mayGiveRole(admin, ' CEO '), true);
  for (const who of [manager, salesHead, fleet, artist, undefined]) assert.equal(mayGiveRole(who, 'ceo'), false);
  for (const role of ['artist', 'sales', 'accounts', 'employee', 'manager', 'admin']) assert.equal(mayGiveRole(manager, role), true, role);
});
