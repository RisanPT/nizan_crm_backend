// Fuel efficiency of one vehicle, worked out from its fuel fill-ups.
//
// Pure functions (no database) so the maths can be unit-tested with exact
// numbers: tests/fuelEfficiency.test.js.
//
// HOW "ACTUAL" IS MEASURED — the standard fill-up method
//   Each fuel entry records the odometer and the litres put in. Between two
//   consecutive fill-ups the vehicle burnt (roughly) the litres of the LATER
//   fill, over the km between the two odometer readings:
//
//        km between fills ÷ litres in the later fill  =  km per litre
//
//   The first fill only sets the starting odometer — its litres are not counted,
//   because they refilled fuel burnt BEFORE it. This is exact when every fill
//   tops the tank up; part-fills average out over several fill-ups, which is
//   why the result carries a confidence level and the number of fill-ups used.
//
// If there aren't two usable fill-ups, we fall back to completed-trip km ÷
// litres bought (rough, labelled "low" confidence); with no litres → no figure.

import { istMonthKey } from './istDate.js';

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

/// km / l for petrol & diesel, km / kg for CNG, km / kWh for electric.
export const mileageUnit = (fuelType) =>
  fuelType === 'electric' ? 'km/kWh' : fuelType === 'cng' ? 'km/kg' : 'km/l';

// What a believable reading looks like, per unit. An interval outside this (a
// mistyped odometer, a missed fill-up in between) is shown but kept OUT of the
// average so one typo can't wreck it.
const SANE = {
  'km/l': [1.5, 80],
  'km/kg': [3, 60],
  'km/kWh': [1, 15],
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/// Intervals between consecutive odometer-stamped fill-ups.
export const fillUpIntervals = (fills, unit) => {
  const usable = (fills || [])
    .map((f) => ({
      date: f.date,
      odometerKm: num(f.odometerKm),
      liters: num(f.liters),
      amount: num(f.totalAmount),
    }))
    .filter((f) => f.odometerKm > 0 && f.liters > 0)
    .sort((a, b) => a.odometerKm - b.odometerKm || new Date(a.date) - new Date(b.date));

  const [lo, hi] = SANE[unit] ?? SANE['km/l'];
  const out = [];
  for (let i = 1; i < usable.length; i += 1) {
    const prev = usable[i - 1];
    const cur = usable[i];
    const km = cur.odometerKm - prev.odometerKm;
    if (km <= 0) continue; // same reading twice → nothing driven between them
    const perUnit = km / cur.liters;
    out.push({
      date: cur.date,
      fromKm: prev.odometerKm,
      toKm: cur.odometerKm,
      km: round1(km),
      liters: round2(cur.liters),
      amount: round2(cur.amount),
      efficiency: round2(perUnit),
      suspect: perUnit < lo || perUnit > hi,
    });
  }
  return out;
};

/**
 * @param {object} o
 * @param {Array}  o.fills        fuel entries { date, odometerKm, liters, totalAmount } (rejected ones already removed)
 * @param {Array}  [o.trips]      completed trips { km, completedAt } — fallback + monthly km
 * @param {number} [o.ratedMileage]
 * @param {number} [o.tankCapacity]
 * @param {string} [o.fuelType]
 */
export const computeEfficiency = ({ fills = [], trips = [], ratedMileage = 0, tankCapacity = 0, fuelType = 'petrol' }) => {
  const unit = mileageUnit(fuelType);
  const rated = num(ratedMileage) > 0 ? round2(num(ratedMileage)) : null;
  const tank = num(tankCapacity) > 0 ? num(tankCapacity) : null;

  const allFills = (fills || []).filter((f) => num(f.liters) > 0);
  const totalLitres = allFills.reduce((s, f) => s + num(f.liters), 0);
  const totalSpend = (fills || []).reduce((s, f) => s + num(f.totalAmount), 0);
  const avgPricePerUnit = totalLitres > 0 ? round2(allFills.reduce((s, f) => s + num(f.totalAmount), 0) / totalLitres) : null;

  const intervals = fillUpIntervals(fills, unit);
  const good = intervals.filter((i) => !i.suspect);

  let method = 'none';
  let confidence = 'none';
  let actual = null;
  let kmTracked = 0;
  let litresUsed = 0;
  let costPerKm = null;

  if (good.length > 0) {
    kmTracked = good.reduce((s, i) => s + i.km, 0);
    litresUsed = good.reduce((s, i) => s + i.liters, 0);
    actual = round2(kmTracked / litresUsed);
    const spend = good.reduce((s, i) => s + i.amount, 0);
    costPerKm = kmTracked > 0 && spend > 0 ? round2(spend / kmTracked) : null;
    method = 'fill_ups';
    confidence = good.length >= 3 ? 'high' : 'medium';
  } else {
    // Fallback: trip km ÷ litres bought. Only when both exist.
    const tripKm = (trips || []).reduce((s, t) => s + num(t.km), 0);
    if (tripKm > 0 && totalLitres > 0) {
      actual = round2(tripKm / totalLitres);
      kmTracked = round1(tripKm);
      litresUsed = round2(totalLitres);
      costPerKm = totalSpend > 0 ? round2(totalSpend / tripKm) : null;
      method = 'trips';
      confidence = 'low';
    }
  }

  // How the actual figure compares with the rated one. The percentage is shown
  // for any figure, but only a fill-up measurement is trusted enough to raise a
  // good / watch / poor flag — the trip-based fallback is rough (fuel bought is
  // not fuel burnt in the same window) and would give false alarms.
  let vsRatedPercent = null;
  let status = 'unknown';
  if (rated && actual) {
    vsRatedPercent = Math.round((actual / rated) * 100);
    if (method === 'fill_ups') {
      status = vsRatedPercent >= 90 ? 'good' : vsRatedPercent >= 75 ? 'watch' : 'poor';
    }
  }

  // Month-by-month (IST), newest first: litres/spend from the fills, km from the
  // intervals they closed (or, with no intervals, from completed trips).
  const months = new Map();
  const month = (d) => {
    const k = istMonthKey(d);
    if (!months.has(k)) months.set(k, { month: k, liters: 0, spend: 0, km: 0, litersDriven: 0 });
    return months.get(k);
  };
  for (const f of allFills) {
    const m = month(f.date);
    m.liters = round2(m.liters + num(f.liters));
    m.spend = round2(m.spend + num(f.totalAmount));
  }
  for (const i of good) {
    const m = month(i.date);
    m.km = round1(m.km + i.km);
    m.litersDriven = round2(m.litersDriven + i.liters); // litres of the intervals counted in `km`
  }
  if (good.length === 0) {
    for (const t of trips || []) month(t.completedAt).km = round1(month(t.completedAt).km + num(t.km));
  }
  // A month's efficiency divides the km of its intervals by the litres of those
  // SAME intervals (not every litre bought, which includes a baseline fill).
  const monthly = [...months.values()]
    .map(({ litersDriven, ...m }) => ({
      ...m,
      efficiency: m.km > 0 && litersDriven > 0 ? round2(m.km / litersDriven) : null,
    }))
    .sort((a, b) => (a.month < b.month ? 1 : -1));

  const lastFill = [...(fills || [])].sort((a, b) => new Date(b.date) - new Date(a.date))[0] ?? null;

  return {
    unit,
    rated,
    actual,
    vsRatedPercent,
    status, // good | watch | poor | unknown
    method, // fill_ups | trips | none
    confidence, // high | medium | low | none
    fillUpsUsed: method === 'fill_ups' ? good.length + 1 : 0,
    intervalsUsed: method === 'fill_ups' ? good.length : 0,
    suspectIntervals: intervals.filter((i) => i.suspect).length,
    kmTracked: round1(kmTracked),
    litresUsed: round2(litresUsed),
    costPerKm,
    avgPricePerUnit,
    fuelSpend: Math.round(totalSpend),
    fillCount: (fills || []).length,
    lastFillDate: lastFill?.date ?? null,
    tankCapacity: tank,
    // How far a full tank goes: at the rated figure, and at the figure it's
    // really achieving.
    ratedRangeKm: rated && tank ? Math.round(rated * tank) : null,
    actualRangeKm: actual && tank ? Math.round(actual * tank) : null,
    intervals: intervals.slice(-12).reverse(),
    monthly: monthly.slice(0, 6),
  };
};
