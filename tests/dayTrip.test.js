// Pure unit tests (no database, no network): node --test tests/dayTrip.test.js
//
// The "map" here is a straight line with the headquarters at 0: a point's
// longitude is its position and 1 unit = 10 km, so every expected number can be
// checked by hand:   HQ(0)  A(1)  B(3)  C(6)
import test from 'node:test';
import assert from 'node:assert/strict';
import { planDay, daySignature } from '../utils/dayTrip.js';

const hq = { lat: 11, lng: 0, label: 'HQ' };
const at = { A: 1, B: 3, C: 6 };
const km = (a, b) => Math.abs(a.lng - b.lng) * 10;

const work = (name, hour, extra = {}) => ({
  id: name,
  label: `Work ${name}`,
  serviceStart: `2026-10-22T${String(hour).padStart(2, '0')}:00:00+05:30`,
  travelDistanceKm: 0,
  ...extra,
});

const deps = (overrides = {}) => ({
  hq,
  placeOf: async (w) => (w.id in at ? { lat: 11, lng: at[w.id], label: w.label } : null),
  legOf: async (a, b) => ({ km: km(a, b), durationMin: Math.round(km(a, b)) }),
  ...overrides,
});

test('ONE work: HQ → work → HQ, total = 2 × the one-way distance', async () => {
  const r = await planDay({ works: [work('A', 9)], ...deps() });
  assert.equal(r.rule, 'round_trip');
  assert.deepEqual(r.legs.map((l) => [l.kind, l.from, l.to, l.km]), [
    ['out', 'HQ', 'Work A', 10],
    ['return', 'Work A', 'HQ', 10],
  ]);
  assert.equal(r.plannedKm, 20);
  assert.equal(r.legs[1].mirrored, true);
  assert.equal(r.approximate, false);
  assert.deepEqual(r.perWorkKm, { A: 20 });
});

test('TWO works: HQ → 1st → 2nd → HQ', async () => {
  const r = await planDay({ works: [work('A', 9), work('B', 14)], ...deps() });
  assert.equal(r.rule, 'multi_stop');
  assert.deepEqual(r.legs.map((l) => [l.kind, l.from, l.to, l.km]), [
    ['out', 'HQ', 'Work A', 10],
    ['between', 'Work A', 'Work B', 20],
    ['return', 'Work B', 'HQ', 30],
  ]);
  assert.equal(r.plannedKm, 60);
  // each work is charged the leg that reaches it; the way home goes to the last work
  assert.deepEqual(r.perWorkKm, { A: 10, B: 50 });
});

test('THREE works: HQ → 1st → 2nd → 3rd → HQ', async () => {
  const r = await planDay({ works: [work('A', 8), work('B', 11), work('C', 15)], ...deps() });
  assert.equal(r.plannedKm, 10 + 20 + 30 + 60);
  assert.deepEqual(r.legs.map((l) => l.kind), ['out', 'between', 'between', 'return']);
  assert.deepEqual(r.perWorkKm, { A: 10, B: 20, C: 90 });
});

test('works are taken in order of their START TIME, whatever order they arrive in', async () => {
  const r = await planDay({ works: [work('C', 15), work('A', 8), work('B', 11)], ...deps() });
  assert.deepEqual(r.stops.map((s) => s.bookingId), ['A', 'B', 'C']);
  assert.equal(r.plannedKm, 120);
});

test('start time decides the order, not the id: C (8am) → A (3pm)', async () => {
  const r = await planDay({ works: [work('A', 15), work('C', 8)], ...deps() });
  assert.deepEqual(r.stops.map((s) => s.bookingId), ['C', 'A']);
  assert.deepEqual(r.legs.map((l) => [l.from, l.to, l.km]), [
    ['HQ', 'Work C', 60],
    ['Work C', 'Work A', 50],
    ['Work A', 'HQ', 10],
  ]);
  assert.equal(r.plannedKm, 120);
});

test('the total always equals the sum of the per-work shares', async () => {
  for (const names of [['A'], ['A', 'B'], ['A', 'B', 'C']]) {
    const r = await planDay({ works: names.map((n, i) => work(n, 8 + i * 3)), ...deps() });
    const sum = Object.values(r.perWorkKm).reduce((s, v) => s + v, 0);
    assert.equal(Math.round(sum * 10) / 10, r.plannedKm, names.join(''));
  }
});

test('two works at the SAME venue: a 0 km leg, and no map call is made for it', async () => {
  let calls = 0;
  const r = await planDay({
    works: [work('A', 9), work('A2', 12)],
    ...deps({
      placeOf: async (w) => ({ lat: 11, lng: 1, label: w.label }), // both at A
      legOf: async (a, b) => { calls += 1; return { km: km(a, b), durationMin: 5 }; },
    }),
  });
  assert.deepEqual(r.legs.map((l) => l.km), [10, 0, 10]);
  assert.equal(calls, 2); // HQ→A and A→HQ only
  assert.equal(r.plannedKm, 20);
});

test('no works → an empty plan, not an error', async () => {
  const r = await planDay({ works: [], ...deps() });
  assert.equal(r.rule, 'none');
  assert.equal(r.plannedKm, 0);
  assert.deepEqual(r.legs, []);
});

test('a work whose location can\'t be found uses 2 × its saved HQ distance, and is flagged', async () => {
  const r = await planDay({
    works: [work('A', 9), work('X', 12, { travelDistanceKm: 25 })], // X has no map location
    ...deps(),
  });
  assert.equal(r.approximate, true);
  assert.ok(r.warnings.some((w) => w.includes('Work X') && w.includes('location not found')));
  const kinds = r.legs.map((l) => l.kind);
  assert.ok(kinds.includes('estimate'));
  // HQ→A (10) + A→HQ (10) for the placed work, plus 2 × 25 for X
  assert.equal(r.plannedKm, 10 + 10 + 50);
  assert.equal(r.perWorkKm.X, 50);
});

test('a single unlocated work with no saved distance: 0 km, flagged', async () => {
  const r = await planDay({ works: [work('X', 9)], ...deps() });
  assert.equal(r.plannedKm, 0);
  assert.equal(r.approximate, true);
  assert.equal(r.warnings.length, 1);
});

test('a leg the map service fails on is left out and flagged, never guessed', async () => {
  const r = await planDay({
    works: [work('A', 9), work('B', 14)],
    ...deps({
      legOf: async (a, b) => {
        if (a.label === 'Work A' && b.label === 'Work B') throw new Error('timeout');
        return { km: km(a, b), durationMin: 1 };
      },
    }),
  });
  assert.equal(r.approximate, true);
  assert.ok(r.warnings.some((w) => w.includes('timeout')));
  assert.equal(r.legs.find((l) => l.kind === 'between').km, null);
  assert.equal(r.plannedKm, 10 + 30); // the two legs that WERE measured
});

test('approximate (pincode-area) locations are flagged', async () => {
  const r = await planDay({
    works: [work('A', 9)],
    ...deps({ placeOf: async (w) => ({ lat: 11, lng: 1, label: w.label, approximate: true }) }),
  });
  assert.equal(r.approximate, true);
  assert.equal(r.stops[0].approximate, true);
});

test('drive time for a single work counts both ways', async () => {
  const r = await planDay({ works: [work('A', 9)], ...deps() });
  assert.equal(r.plannedMin, 20); // 10 min out + 10 min back
});

test('signature: same inputs → same value; any change to a work or the HQ → different', () => {
  const base = { works: [work('A', 9, { mapUrl: 'm1' }), work('B', 14)], hq };
  const s1 = daySignature(base);
  assert.equal(daySignature({ ...base, works: [...base.works].reverse() }), s1); // order of input irrelevant
  assert.notEqual(daySignature({ ...base, works: [base.works[0]] }), s1); // a work removed
  assert.notEqual(daySignature({ ...base, works: [{ ...base.works[0], mapUrl: 'm2' }, base.works[1]] }), s1); // venue changed
  assert.notEqual(daySignature({ ...base, hq: { ...hq, lng: 0.5 } }), s1); // HQ moved
});
