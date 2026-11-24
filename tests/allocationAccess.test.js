import test from 'node:test';
import assert from 'node:assert/strict';
import { isArtistHead, isSalesRole, mayAllocate, mayApproveExtra, mayChangeAllocationMode, mayEditAllocationSettings, mayManageTeams, mayViewAllocation, mayViewBookingAllocation } from '../utils/allocationAccess.js';

const who = (role, extra = {}) => ({ role, ...extra });

test('who sees, allocates, approves extras, manages teams, switches the mode', () => {
  const rows = [
    // role                       view  allocate approve teams  rules  mode   a booking's status
    [who('admin'),                 true, true,    true,   true,  true,  true,  true],
    [who('manager'),               true, true,    true,   true,  true,  true,  true],
    // the whole CRM team sets up the teams (main artist, assistants, preferred locations); the rules stay with the heads
    [who('crm'),                   true, true,    false,  true,  false, false, true],
    [who('crm', { isDepartmentHead: true }), true, true, false, true, true, false, true],
    [who('crm_manager'),           true, true,    false,  true,  true,  false, true],
    [who('artist_head'),           true, true,    true,   true,  true,  false, true],
    [who('artist', { artistHead: true }), true, true, true, true, true, false, true],
    [who('regional_artist_head'),  true, false,   false,  false, false, false, true],
    [who('ceo'),                   true, false,   false,  false, false, false, true],
    // sales: no board, no allocating — but they read their booking's artist (or why it waits)
    [who('sales'),                 false, false,  false,  false, false, false, true],
    [who('sales_executive'),       false, false,  false,  false, false, false, true],
    [who('artist'),                false, false,  false,  false, false, false, false],
    [who('accounts'),              false, false,  false,  false, false, false, false],
  ];
  for (const [u, view, alloc, approve, manage, rules, mode, status] of rows) {
    const label = `${u.role}${u.artistHead ? '+flag' : ''}${u.isDepartmentHead ? '+head' : ''}`;
    assert.deepEqual(
      [mayViewAllocation(u), mayAllocate(u), mayApproveExtra(u), mayManageTeams(u), mayEditAllocationSettings(u), mayChangeAllocationMode(u), mayViewBookingAllocation(u)],
      [view, alloc, approve, manage, rules, mode, status],
      label,
    );
  }
  assert.deepEqual([isSalesRole(who('sales_manager')), isSalesRole(who('crm')), isSalesRole(null)], [true, false, false]);
  assert.equal(isArtistHead(who('artist', { artistHead: true })), true);
  assert.equal(isArtistHead(null), false);
});
