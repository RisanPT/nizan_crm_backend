// Pure unit tests (no database): node --test tests/fuelEfficiency.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeEfficiency, fillUpIntervals, mileageUnit } from '../utils/fuelEfficiency.js';
import { suggestCategory, seatsFit, defaultSeatsFor, CATEGORY_KEYS } from '../utils/vehicleCategories.js';

const fill = (date, odometerKm, liters, totalAmount = 0) => ({ date, odometerKm, liters, totalAmount });

test('units follow the fuel type', () => {
  assert.equal(mileageUnit('petrol'), 'km/l');
  assert.equal(mileageUnit('diesel'), 'km/l');
  assert.equal(mileageUnit('cng'), 'km/kg');
  assert.equal(mileageUnit('electric'), 'km/kWh');
});

test('fill-up method: km between fills ÷ litres of the LATER fill; the first fill only sets the start', () => {
  // 10,000 → 10,300 → 10,640: 300 km on 20 L (15 km/l), 340 km on 20 L (17 km/l)
  const r = computeEfficiency({
    fills: [
      fill('2026-10-01T05:00:00Z', 10000, 35, 3500), // baseline: its litres are NOT counted
      fill('2026-10-08T05:00:00Z', 10300, 20, 2000),
      fill('2026-10-15T05:00:00Z', 10640, 20, 2100),
    ],
    ratedMileage: 16,
    tankCapacity: 40,
  });
  assert.equal(r.method, 'fill_ups');
  assert.equal(r.kmTracked, 640);
  assert.equal(r.litresUsed, 40);
  assert.equal(r.actual, 16); // 640 / 40
  assert.equal(r.intervalsUsed, 2);
  assert.equal(r.fillUpsUsed, 3);
  assert.equal(r.confidence, 'medium'); // 2 intervals
  assert.equal(r.costPerKm, 6.41); // (2000+2100)/640
  assert.equal(r.vsRatedPercent, 100);
  assert.equal(r.status, 'good');
  assert.equal(r.ratedRangeKm, 640); // 16 × 40
  assert.equal(r.actualRangeKm, 640);
});

test('status bands against the rated figure', () => {
  const mk = (kmpl) =>
    computeEfficiency({
      fills: [fill('2026-10-01T00:00:00Z', 1000, 10), fill('2026-10-05T00:00:00Z', 1000 + kmpl * 10, 10)],
      ratedMileage: 20,
    });
  assert.equal(mk(18).status, 'good'); // 90 %
  assert.equal(mk(15).status, 'watch'); // 75 %
  assert.equal(mk(14).status, 'poor'); // 70 %
  assert.equal(mk(14).vsRatedPercent, 70);
});

test('a mistyped odometer is shown but kept out of the average', () => {
  const r = computeEfficiency({
    fills: [
      fill('2026-10-01T00:00:00Z', 10000, 30),
      fill('2026-10-05T00:00:00Z', 10300, 20), // 15 km/l  ✔
      fill('2026-10-09T00:00:00Z', 19000, 20), // typo → 435 km/l  ✘
      fill('2026-10-12T00:00:00Z', 19300, 20), // 15 km/l  ✔
    ],
    ratedMileage: 15,
  });
  assert.equal(r.suspectIntervals, 1);
  assert.equal(r.intervalsUsed, 2);
  assert.equal(r.actual, 15);
  assert.equal(r.intervals.length, 3); // all still listed, newest first
});

test('same odometer twice (double entry) adds nothing', () => {
  const iv = fillUpIntervals(
    [fill('2026-10-01T00:00:00Z', 5000, 10), fill('2026-10-02T00:00:00Z', 5000, 10), fill('2026-10-09T00:00:00Z', 5150, 10)],
    'km/l',
  );
  assert.equal(iv.length, 1);
  assert.equal(iv[0].km, 150);
});

test('entries without litres or odometer are ignored for the interval maths but still count as spend', () => {
  const r = computeEfficiency({
    fills: [fill('2026-10-01T00:00:00Z', 0, 0, 500), fill('2026-10-02T00:00:00Z', 1000, 10, 1000)],
    ratedMileage: 15,
  });
  assert.equal(r.method, 'none');
  assert.equal(r.actual, null);
  assert.equal(r.status, 'unknown');
  assert.equal(r.fuelSpend, 1500);
  assert.equal(r.avgPricePerUnit, 100); // 1000 / 10 L (only the entry with litres)
});

test('falls back to completed-trip km ÷ litres bought, labelled low confidence', () => {
  const r = computeEfficiency({
    fills: [fill('2026-10-02T00:00:00Z', 0, 20, 2000), fill('2026-10-12T00:00:00Z', 0, 20, 2000)],
    trips: [
      { km: 300, completedAt: '2026-10-05T00:00:00Z' },
      { km: 260, completedAt: '2026-10-10T00:00:00Z' },
    ],
    ratedMileage: 15,
  });
  assert.equal(r.method, 'trips');
  assert.equal(r.confidence, 'low');
  assert.equal(r.actual, 14); // 560 / 40
  assert.equal(r.costPerKm, 7.14); // 4000 / 560
  // shown against the rated figure, but too rough to raise a good / watch / poor flag
  assert.equal(r.vsRatedPercent, 93);
  assert.equal(r.status, 'unknown');
});

test('a rough trip-based figure never flags a vehicle "poor" (fuel bought ≠ fuel burnt)', () => {
  const r = computeEfficiency({
    fills: [fill('2026-10-02T00:00:00Z', 0, 20, 2000)],
    trips: [{ km: 30, completedAt: '2026-10-05T00:00:00Z' }], // 1.5 km/l only because the tank isn't used up yet
    ratedMileage: 12,
  });
  assert.equal(r.actual, 1.5);
  assert.equal(r.status, 'unknown');
});

test('no data at all → no figures, but nothing throws', () => {
  const r = computeEfficiency({});
  assert.equal(r.actual, null);
  assert.equal(r.method, 'none');
  assert.equal(r.fillCount, 0);
  assert.deepEqual(r.monthly, []);
});

test('electric vehicles use their own sane range', () => {
  const r = computeEfficiency({
    fuelType: 'electric',
    ratedMileage: 6,
    fills: [fill('2026-10-01T00:00:00Z', 1000, 20), fill('2026-10-04T00:00:00Z', 1120, 20)],
  });
  assert.equal(r.unit, 'km/kWh');
  assert.equal(r.actual, 6);
  assert.equal(r.suspectIntervals, 0);
});

test('monthly breakdown is by IST month, newest first', () => {
  const r = computeEfficiency({
    fills: [
      fill('2026-09-20T05:00:00Z', 1000, 10, 1000),
      fill('2026-09-28T05:00:00Z', 1150, 10, 1000),
      fill('2026-10-06T05:00:00Z', 1300, 10, 1000),
    ],
  });
  assert.deepEqual(r.monthly.map((m) => m.month), ['2026-10', '2026-09']);
  assert.equal(r.monthly[1].km, 150);
  assert.equal(r.monthly[1].efficiency, 15);
});

// ── vehicle categories ─────────────────────────────────────────────────────
test('category list has the expected keys and a unique key each', () => {
  for (const k of ['sedan', 'xl', 'mpv', 'hatchback', 'suv', 'tempo_traveller', 'bike', 'other']) {
    assert.ok(CATEGORY_KEYS.includes(k), k);
  }
  assert.equal(new Set(CATEGORY_KEYS).size, CATEGORY_KEYS.length);
});

test('suggestCategory picks the smallest vehicle that takes the team', () => {
  assert.equal(suggestCategory(0).key, 'sedan');
  assert.equal(suggestCategory(3).key, 'sedan');
  assert.equal(suggestCategory(4).key, 'sedan');
  assert.equal(suggestCategory(5).key, 'xl');
  assert.equal(suggestCategory(6).key, 'xl');
  assert.equal(suggestCategory(7).key, 'mpv');
  assert.equal(suggestCategory(8).key, 'tempo_traveller');
  assert.equal(suggestCategory(12).key, 'tempo_traveller');
  assert.equal(suggestCategory(12).needsMultiple, false);
  assert.equal(suggestCategory(13).needsMultiple, true);
});

test('seatsFit: unknown capacity is "can\'t say", not "fits"', () => {
  assert.equal(seatsFit(0, 3), null);
  assert.equal(seatsFit(4, 4), true);
  assert.equal(seatsFit(4, 5), false);
  assert.equal(defaultSeatsFor('mpv'), 7);
  assert.equal(defaultSeatsFor('nope'), 0);
});
