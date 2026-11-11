// Pure unit tests: node --test tests/workArtists.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { artistsOf } from '../utils/workArtists.js';

const s = (employeeId, artistName, roleType) => ({ employeeId, artistName, roleType });

test('leads first, then assistants, in the order assigned; the driver is not an artist', () => {
  const a = artistsOf({
    assignedStaff: [s('1', 'Neha', 'assistant'), s('2', 'Priya', 'lead'), s('9', 'Ravi', 'driver'), s('3', 'Divya', 'assistant')],
  });
  assert.deepEqual(a.map((x) => [x.name, x.roleType]), [['Priya', 'lead'], ['Neha', 'assistant'], ['Divya', 'assistant']]);
});

test('per-package assignments are included, and each person counts once (a lead listing wins)', () => {
  const a = artistsOf({
    assignedStaff: [s('1', 'Neha', 'assistant')],
    bookingItems: [{ assignedStaff: [s('1', 'Neha', 'lead'), s('4', 'Meera', 'assistant')] }, { assignedStaff: [s('4', 'Meera', 'assistant')] }],
  });
  assert.deepEqual(a.map((x) => [x.name, x.roleType]), [['Neha', 'lead'], ['Meera', 'assistant']]);
});

test('nothing assigned (or a malformed entry) → an empty list, no throw', () => {
  assert.deepEqual(artistsOf({}), []);
  assert.deepEqual(artistsOf(null), []);
  assert.deepEqual(artistsOf({ assignedStaff: [null, {}, { artistName: 'No id', roleType: 'lead' }] }), []);
});

test('a person with no name stored still counts (name is empty, never undefined)', () => {
  const [a] = artistsOf({ assignedStaff: [s('1', undefined, 'lead')] });
  assert.equal(a.name, '');
});
