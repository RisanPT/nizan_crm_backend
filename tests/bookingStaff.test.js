import test from 'node:test';
import assert from 'node:assert/strict';
import { leadOf, normalizeAssignedStaff, staffByUnit, summarizeAssignedStaff, withTeamStaff } from '../utils/bookingStaff.js';

const e = (id, name, extra = {}) => ({ _id: id, name, phone: `9${id}`, specialization: '', works: [], type: 'in-house', ...extra });

test('the moved helpers behave as before: normalize, then merge package staff once each', () => {
  const s = normalizeAssignedStaff([{ employeeId: 'a', artistName: 'Nihala', roleType: 'lead', specialization: 'Bridal' }, { artistName: 'no id' }]);
  assert.equal(s.length, 1);
  assert.deepEqual(s[0].works, ['Bridal']);
  const merged = summarizeAssignedStaff([{ assignedStaff: [{ employeeId: 'a', artistName: 'N', roleType: 'lead' }] }, { assignedStaff: [{ employeeId: 'a', artistName: 'N', roleType: 'lead' }, { employeeId: 'b', artistName: 'Ameena' }] }], []);
  assert.deepEqual(merged.map((x) => x.employeeId), ['a', 'b']);
  assert.deepEqual(summarizeAssignedStaff([], [{ employeeId: 'z', artistName: 'Z' }]).map((x) => x.employeeId), ['z']);
});

test('staff by unit: a booking without packages is one unit; a package without its own team uses the booking\'s', () => {
  assert.deepEqual([...staffByUnit({ assignedStaff: [{ employeeId: 'a', artistName: 'N', roleType: 'lead' }] }).keys()], ['b']);
  const units = staffByUnit({ assignedStaff: [{ employeeId: 'old', artistName: 'Old', roleType: 'lead' }], bookingItems: [{ assignedStaff: [{ employeeId: 'a', artistName: 'N', roleType: 'lead' }] }, { assignedStaff: [] }] });
  assert.deepEqual([...units.keys()], ['i:0', 'i:1']);
  assert.equal(leadOf(units.get('i:0')).employeeId, 'a');
  assert.equal(leadOf(units.get('i:1')).employeeId, 'old');
  assert.equal(leadOf([]), null);
});

test('a team put on a package: lead + assistants replace the old ones; the driver and associates stay', () => {
  const existing = [
    { employeeId: 'oldLead', artistName: 'Old', roleType: 'lead' },
    { employeeId: 'oldAsst', artistName: 'Old asst', roleType: 'assistant' },
    { employeeId: 'drv', artistName: 'Driver', roleType: 'driver' },
    { employeeId: 'assoc', artistName: 'Freelancer', roleType: 'assistant' },
  ];
  const out = withTeamStaff(existing, { lead: e('n', 'Nihala', { specialization: 'Bridal' }), assistants: [e('a1', 'Ameena'), e('a2', 'Safa')] }, { associateIds: ['assoc'] });
  assert.deepEqual(out.map((s) => [s.employeeId, s.roleType]), [['n', 'lead'], ['a1', 'assistant'], ['a2', 'assistant'], ['drv', 'driver'], ['assoc', 'assistant']]);
  assert.deepEqual([out[0].role, out[0].specialization, out[0].phone], ['Lead Artist', 'Bridal', '9n']);
  // the same person twice is kept once
  assert.equal(withTeamStaff([], { lead: e('n', 'Nihala'), assistants: [e('n', 'Nihala')] }).length, 1);
});
