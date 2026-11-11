// Pure unit tests: node --test tests/dayDistance.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { dayDistance, tripKm } from '../utils/dayDistance.js';

const legs = [
  { kind: 'out', km: 10 },
  { kind: 'between', km: 20 },
  { kind: 'return', km: 30 },
];
const done = (startKm, endKm) => ({ tripStatus: 'completed', startKm, endKm });

test('the odometer is compared with the plan WITHOUT the way home', () => {
  const d = dayDistance({ legs, plannedKm: 60, works: [done(1000, 1012), done(1012, 1030)] });
  assert.equal(d.returnKm, 30);
  assert.equal(d.plannedTrackedKm, 30);
  assert.equal(d.trackedKm, 30);
  assert.deepEqual(d.variance, { km: 0, percent: 0 });
  assert.equal(d.status, 'ok');
  assert.equal(d.estimatedDayKm, 60);
});

test('status bands: within 10% ok, more is over, less is under', () => {
  const at = (end) => dayDistance({ legs, plannedKm: 60, works: [done(1000, end)] });
  assert.equal(at(1033).status, 'ok'); // +10%
  assert.equal(at(1034).status, 'over'); // +13%
  assert.equal(at(1027).status, 'ok'); // −10%
  assert.equal(at(1020).status, 'under'); // −33%
  assert.equal(at(1034).variance.percent, 13);
});

test('one work: out + mirrored return', () => {
  const d = dayDistance({ legs: [{ kind: 'out', km: 12 }, { kind: 'return', km: 12 }], plannedKm: 24, works: [done(500, 512.4)] });
  assert.equal(d.plannedTrackedKm, 12);
  assert.equal(d.trackedKm, 12.4);
  assert.equal(d.status, 'ok');
});

test('an unfinished trip (or a missing odometer) means "in progress", with no variance claimed', () => {
  const open = dayDistance({ legs, plannedKm: 60, works: [done(1000, 1012), { tripStatus: 'in_progress', startKm: 1012, endKm: null }] });
  assert.equal(open.status, 'in_progress');
  assert.equal(open.variance, null);
  assert.equal(open.estimatedDayKm, null);
  const noKm = dayDistance({ legs, plannedKm: 60, works: [{ tripStatus: 'completed', startKm: null, endKm: null }] });
  assert.equal(noKm.status, 'in_progress');
});

test('no usable route → "no_route", never a made-up comparison', () => {
  assert.equal(dayDistance({ legs: [], plannedKm: 0, works: [done(1, 2)] }).status, 'no_route');
  assert.equal(dayDistance({ legs, plannedKm: 60, planError: 'ORS_API_KEY missing', works: [done(1000, 1030)] }).status, 'no_route');
  assert.equal(dayDistance({ legs: [{ kind: 'out', km: 10 }, { kind: 'return', km: null }], plannedKm: 10, works: [done(1000, 1010)] }).status, 'no_route');
});

test('no works that day → "no_works"', () => {
  assert.equal(dayDistance({ legs: [], plannedKm: 0, works: [] }).status, 'no_works');
});

test('an odometer that went backwards is not a distance', () => {
  assert.equal(tripKm({ startKm: 100, endKm: 90 }), null);
  assert.equal(tripKm({ startKm: 100, endKm: 100 }), 0);
  assert.equal(dayDistance({ legs, plannedKm: 60, works: [done(1030, 1000)] }).status, 'in_progress');
});
