// Pure unit tests (no database, no network): node --test tests/artistDay.test.js
//
// The "map" is a straight line: a point's longitude is its position and 1 unit = 10 km,
// so every expected number can be checked by hand:   A(1)  B(3)  C(6)
import test from 'node:test';
import assert from 'node:assert/strict';
import { planArtistLegs, artistDaySignature, positionsInDay, inTimeOrder } from '../utils/artistDay.js';

const at = { A: 1, B: 3, C: 6, A2: 1 }; // A2 is the same spot as A
const km = (a, b) => Math.abs(a.lng - b.lng) * 10;

const work = (name, hour, extra = {}) => ({
  id: name,
  label: `Work ${name}`,
  serviceStart: `2026-10-22T${String(hour).padStart(2, '0')}:00:00+05:30`,
  ...extra,
});

const deps = (overrides = {}) => ({
  placeOf: async (w) => (w.id in at ? { lat: 11, lng: at[w.id], label: w.label } : null),
  legOf: async (a, b) => ({ km: km(a, b), durationMin: Math.round(km(a, b) * 2) }),
  ...overrides,
});

test('one work, or none: nothing to travel between', async () => {
  assert.deepEqual((await planArtistLegs({ works: [work('A', 9)], ...deps() })).legs, []);
  assert.deepEqual((await planArtistLegs({ works: [], ...deps() })).legs, []);
});

test('several works: one leg from each work to the NEXT, in start-time order (input order does not matter)', async () => {
  const r = await planArtistLegs({ works: [work('C', 17), work('A', 8), work('B', 12)], ...deps() });
  assert.deepEqual(r.order, ['A', 'B', 'C']);
  assert.deepEqual(r.legs.map((l) => [l.fromId, l.toId, l.km, l.durationMin]), [
    ['A', 'B', 20, 40],
    ['B', 'C', 30, 60],
  ]);
  assert.ok(r.legs.every((l) => l.approximate === false && l.note === ''));
  assert.deepEqual(r.warnings, []);
});

test('there is no return to the studio: the last work has no leg after it', async () => {
  const r = await planArtistLegs({ works: [work('A', 8), work('B', 12)], ...deps() });
  assert.equal(r.legs.length, 1);
  assert.equal(r.legs.at(-1).toId, 'B');
});

test('two works at the same place: 0 km, the map is not asked', async () => {
  let asked = 0;
  const r = await planArtistLegs({ works: [work('A', 8), work('A2', 12)], ...deps({ legOf: async () => { asked++; return { km: 99, durationMin: 99 }; } }) });
  assert.equal(asked, 0);
  assert.deepEqual([r.legs[0].km, r.legs[0].note], [0, 'same_place']);
});

test('a work with no location: its two legs are unmeasured (and say so); the rest are untouched', async () => {
  const r = await planArtistLegs({ works: [work('A', 8), work('X', 11), work('B', 14), work('C', 18)], ...deps() });
  assert.deepEqual(r.legs.map((l) => [l.fromId, l.toId, l.km, l.note]), [
    ['A', 'X', null, 'location_missing'],
    ['X', 'B', null, 'location_missing'],
    ['B', 'C', 30, ''],
  ]);
  assert.ok(r.warnings.some((w) => w.includes('Work X') && w.includes('location not found')));
});

test('a location lookup that throws is a warning, not a crash', async () => {
  const r = await planArtistLegs({
    works: [work('A', 8), work('B', 12)],
    ...deps({ placeOf: async (w) => { if (w.id === 'B') throw new Error('osm down'); return { lat: 11, lng: at[w.id], label: w.label }; } }),
  });
  assert.equal(r.legs[0].km, null);
  assert.ok(r.warnings.some((w) => w.includes('osm down')));
});

test('a road lookup that throws leaves that leg unmeasured and carries on', async () => {
  const r = await planArtistLegs({
    works: [work('A', 8), work('B', 12), work('C', 16)],
    ...deps({ legOf: async (a, b) => { if (a.lng === 1) throw new Error('ors 502'); return { km: km(a, b), durationMin: 5 }; } }),
  });
  assert.deepEqual(r.legs.map((l) => [l.km, l.note]), [[null, 'not_measured'], [30, '']]);
  assert.ok(r.warnings.some((w) => w.includes('ors 502')));
});

test('a leg touching a pincode-only venue is approximate', async () => {
  const r = await planArtistLegs({
    works: [work('A', 8), work('B', 12), work('C', 16)],
    ...deps({ placeOf: async (w) => ({ lat: 11, lng: at[w.id], label: w.label, approximate: w.id === 'B' }) }),
  });
  assert.deepEqual(r.legs.map((l) => l.approximate), [true, true]);
  const exact = await planArtistLegs({ works: [work('A', 8), work('B', 12)], ...deps() });
  assert.equal(exact.legs[0].approximate, false);
});

test('a missing / non-finite road answer is "not measured", never NaN', async () => {
  const r = await planArtistLegs({ works: [work('A', 8), work('B', 12)], ...deps({ legOf: async () => ({ km: Number.NaN }) }) });
  assert.deepEqual([r.legs[0].km, r.legs[0].note], [null, 'not_measured']);
});

test('works that start together keep a stable order (by id)', () => {
  assert.deepEqual(inTimeOrder([work('B', 9), work('A', 9)]).map((w) => w.id), ['A', 'B']);
});

test('signature: same works → same signature in any order; a moved venue or time changes it', () => {
  const a = { ...work('A', 8), mapUrl: 'https://maps/x', address: '', pincode: '673001' };
  const b = { ...work('B', 12), address: 'Mavoor Rd', pincode: '673004' };
  const base = artistDaySignature({ works: [a, b] });
  assert.equal(artistDaySignature({ works: [b, a] }), base);
  assert.notEqual(artistDaySignature({ works: [{ ...a, mapUrl: 'https://maps/y' }, b] }), base);
  assert.notEqual(artistDaySignature({ works: [a, { ...b, address: 'Other Rd' }] }), base);
  assert.notEqual(artistDaySignature({ works: [a, work('B', 13)] }), base);
  assert.notEqual(artistDaySignature({ works: [a] }), base);
});

test('positionsInDay: "work 2 of 3", the next work and the road to it; the last work has none', () => {
  const order = ['A', 'B', 'C'];
  const legs = [
    { fromId: 'A', toId: 'B', km: 20 },
    { fromId: 'B', toId: 'C', km: 30 },
  ];
  const p = positionsInDay(order, legs);
  assert.deepEqual(p.get('A'), { position: 1, total: 3, nextId: 'B', leg: legs[0] });
  assert.deepEqual(p.get('B'), { position: 2, total: 3, nextId: 'C', leg: legs[1] });
  assert.deepEqual(p.get('C'), { position: 3, total: 3, nextId: null, leg: null });
  assert.deepEqual(positionsInDay(['A'], []).get('A'), { position: 1, total: 1, nextId: null, leg: null });
});
