// node --test tests/resolveWorkPlace.test.js
// Coordinate map links are read locally, so no database or network is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWorkPlace } from '../utils/distance.js';

const DAY = '2026-10-23';

test('a map link with coordinates is used as the exact pin', async () => {
  const p = await resolveWorkPlace({ mapUrl: '11.2588, 75.7804' }, DAY);
  assert.deepEqual([p.lat, p.lng, p.method, p.approximate], [11.2588, 75.7804, 'map_link', false]);
});

test('a multi-date booking uses THAT day\'s map, falling back to the booking\'s own', async () => {
  const booking = { mapUrl: '11.2, 75.8', dateMaps: { [DAY]: '11.3, 75.7' } }; // lean() form: a plain object
  assert.equal((await resolveWorkPlace(booking, DAY)).lat, 11.3);
  assert.equal((await resolveWorkPlace(booking, '2026-10-24')).lat, 11.2);
});

test('works with a live Mongoose Map as well as a plain object', async () => {
  const booking = { mapUrl: '', dateMaps: new Map([[DAY, '11.4, 75.6']]) };
  assert.equal((await resolveWorkPlace(booking, DAY)).lat, 11.4);
});

test('nothing usable at all → null (the planner then flags it), never a made-up place', async () => {
  assert.equal(await resolveWorkPlace({ mapUrl: '', address: '', pincode: '' }, DAY), null);
  assert.equal(await resolveWorkPlace({}, DAY), null);
});
