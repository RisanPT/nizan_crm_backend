// Notifications go to the right team; admins get a copy of every one.
// Stubbed models, no database.  node --test tests/notificationTeams.test.js
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import User from '../models/User.js';
import Department from '../models/Department.js';
import Notification from '../models/Notification.js';
import { notify, getSalesLeadIds, MANAGER_ROLES, NOTIFICATION_TYPES } from '../utils/notify.js';

const q = (data) => {
  const c = { select: () => c, lean: async () => data, then: (a, b) => Promise.resolve(data).then(a, b) };
  return c;
};

let depts = [];
let userFinds = [];
let admins = [];
let inserted = [];

Department.find = () => q(depts);
User.find = (filter) => {
  userFinds.push(filter);
  const roles = filter?.role?.$in ?? [];
  // The admin lookup inside notify(); every other lookup returns "s1".
  return { select: async () => (roles.includes('admin') ? admins.map((_id) => ({ _id })) : [{ _id: 's1' }]) };
};
Notification.insertMany = async (docs) => inserted.push(...docs);
Notification.find = () => ({ select: async () => [] });

beforeEach(() => {
  depts = [];
  userFinds = [];
  admins = [];
  inserted = [];
});

test('Sales team = sales-only manager roles, managers in Sales, and the Sales head — not every manager', async () => {
  depts = [{ _id: 'deptSales' }];
  const ids = await getSalesLeadIds();
  assert.deepEqual(ids, ['s1']);
  const f = userFinds[0];
  assert.deepEqual(f.active, { $ne: false });
  assert.deepEqual(f.$or, [
    { role: { $in: ['sales_manager', 'regional_manager'] } },
    { role: { $in: MANAGER_ROLES }, departmentId: { $in: ['deptSales'] } },
    { isDepartmentHead: true, departmentId: { $in: ['deptSales'] } },
  ]);
  // The plain `manager` role on its own is never enough.
  assert.ok(!f.$or.some((c) => c.role && c.role.$in.includes('manager') && !c.departmentId));
});

test('no Sales department in the system → falls back to every manager role', async () => {
  depts = [];
  await getSalesLeadIds();
  assert.deepEqual(userFinds[0].role, { $in: MANAGER_ROLES });
});

test('every notification is copied to the admins', async () => {
  admins = ['a1', 'a2'];
  await notify({ recipients: ['u1'], type: NOTIFICATION_TYPES.NEW_LEAD, title: 'New enquiry' });
  assert.deepEqual(inserted.map((d) => d.recipient).sort(), ['a1', 'a2', 'u1']);
});

test('an admin who is also a recipient gets one copy, not two', async () => {
  admins = ['a1'];
  await notify({ recipients: ['a1', 'u1'], type: NOTIFICATION_TYPES.BOOKING_CREATED });
  assert.deepEqual(inserted.map((d) => d.recipient).sort(), ['a1', 'u1']);
});

test('the person who did the action is not notified, even an admin', async () => {
  admins = ['a1'];
  await notify({ recipients: ['u1'], type: NOTIFICATION_TYPES.FOLLOWUP_COMPLETED, excludeUserId: 'a1' });
  assert.deepEqual(inserted.map((d) => d.recipient), ['u1']);
});

test('nobody to tell → nothing is created, not even for admins', async () => {
  admins = ['a1'];
  await notify({ recipients: [], type: NOTIFICATION_TYPES.NEW_LEAD });
  assert.equal(inserted.length, 0);
});

test('operational types reach admins too (the old "month-end summary only" rule is gone)', async () => {
  admins = ['a1'];
  for (const type of [NOTIFICATION_TYPES.FOLLOWUP_MISSED, NOTIFICATION_TYPES.CLIENT_MESSAGE, 'low_stock']) {
    await notify({ recipients: ['u1'], type });
  }
  assert.equal(inserted.filter((d) => d.recipient === 'a1').length, 3);
});
