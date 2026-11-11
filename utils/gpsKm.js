// GPS tracker km vs the km drivers enter.
//
// The GPS vendor's day-wise report gives one distance per vehicle per day. A driver's
// km for that day is the odometer difference of the day's completed trips. They are NOT
// the same thing, and the comparison has to allow for why:
//   • each trip's odometer covers only the way INTO a work — the drive back to HQ is on no
//     trip (see utils/dayDistance.js) — but the GPS counts it. So the planned way home is
//     added to the driver's side before the two are compared.
//   • odometers and GPS never agree to the metre → a tolerance band.
// Pure — tests/gpsKm.test.js.

import { addDays, isDay } from './istDate.js';

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const sum = (list, f) => list.reduce((s, x) => s + f(x), 0);

/// Within this much of the GPS figure (or the minimum, for short days) counts as a match.
export const TOLERANCE = { percent: 10, minKm: 5 };
/// A day with no driver trip at all is only worth flagging if the vehicle really moved.
export const MOVED_KM = 5;
/// No vehicle covers more than this in a day — a bigger figure is a typo or a wrong unit.
export const MAX_DAY_KM = 3000;
/// Rows accepted in one upload.
export const MAX_ROWS = 5000;

// ── vehicle numbers ─────────────────────────────────────────────────────────

/**
 * A vehicle number reduced to what identifies it, so "KL-57-Y-6100", "KL 57 Y 6100" and
 * "kl57y6100" are one vehicle. An ordinary Indian plate is also normalised for the zero
 * padding people drop or add ("KL-07-AB-1" = "KL 7 AB 0001"); anything else is just
 * upper-cased letters and digits.
 */
export const regKey = (value) => {
  const plain = String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = /^([A-Z]{2})(\d{1,2})([A-Z]{1,3})(\d{1,4})$/.exec(plain);
  return m ? `${m[1]}${Number(m[2])}${m[3]}${m[4].padStart(4, '0')}` : plain;
};

// ── one uploaded row ────────────────────────────────────────────────────────

const isRealDay = (s) => {
  if (!isDay(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

const toNumber = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
};

const hoursOf = (v) => {
  const n = toNumber(v);
  return n !== null && n >= 0 && n <= 24.5 ? round2(n) : null;
};

const textOf = (v) => {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  // the vendor writes this where it could not look the place up
  return /^address not found/i.test(s) ? '' : s.slice(0, 200);
};

/**
 * One row of an upload, checked. The app has already read the spreadsheet; this is the
 * server not taking its word for it.
 * @param {object} raw  { registrationNumber, date: 'YYYY-MM-DD', distanceKm, runningHours?,
 *                        stopHours?, idleHours?, startAddress?, endAddress? }
 * @returns {{ row } | { error: string }}
 */
export const cleanGpsRow = (raw, { today } = {}) => {
  const registrationNumber = String(raw?.registrationNumber ?? '').trim().slice(0, 40);
  const key = regKey(registrationNumber);
  if (key.length < 4) return { error: 'no vehicle number' };

  const dayKey = String(raw?.date ?? '').trim();
  if (!isRealDay(dayKey)) return { error: `"${dayKey.slice(0, 20)}" is not a date` };
  if (dayKey < '2015-01-01') return { error: `${dayKey} is too long ago to be right` };
  if (today && dayKey > addDays(today, 1)) return { error: `${dayKey} is in the future` };

  const km = toNumber(raw?.distanceKm);
  if (km === null) return { error: 'the distance is not a number' };
  if (km < 0) return { error: 'the distance is negative' };
  if (km > MAX_DAY_KM) return { error: `${round1(km)} km in one day is more than a vehicle can cover` };

  return {
    row: {
      regKey: key,
      registrationNumber,
      dayKey,
      distanceKm: round2(km),
      runningHours: hoursOf(raw?.runningHours),
      stopHours: hoursOf(raw?.stopHours),
      idleHours: hoursOf(raw?.idleHours),
      startAddress: textOf(raw?.startAddress),
      endAddress: textOf(raw?.endAddress),
    },
  };
};

/**
 * A whole upload: the clean rows plus what was left out and why. The same vehicle and day
 * twice → the later row wins (the later line of a file is the later export).
 * @returns {{ rows, skipped, problems: string[], duplicates }}
 */
export const cleanGpsRows = (rawRows, { today } = {}) => {
  const byKey = new Map();
  const problems = [];
  let skipped = 0;
  let duplicates = 0;
  rawRows.forEach((raw, i) => {
    const out = cleanGpsRow(raw, { today });
    if (out.error) {
      skipped += 1;
      if (problems.length < 20) problems.push(`Row ${i + 1}: ${out.error}`);
      return;
    }
    const k = `${out.row.regKey}|${out.row.dayKey}`;
    if (byKey.has(k)) duplicates += 1;
    byKey.set(k, out.row);
  });
  return { rows: [...byKey.values()], skipped, problems, duplicates };
};

// ── judging one vehicle-day ─────────────────────────────────────────────────

/// How far apart is still a match: the larger of the minimum and a percentage of the GPS figure.
export const toleranceKm = (gpsKm) => Math.max(TOLERANCE.minKm, round2((TOLERANCE.percent / 100) * gpsKm));

/**
 * GPS against the driver's odometer for a day on which the vehicle has both.
 *   ok           within the tolerance
 *   driver_low   the GPS shows more than the driver entered (km nobody recorded)
 *   driver_high  the driver entered more than the GPS shows
 *   no_gps       the GPS shows (almost) no movement although trips were logged — the tracker
 *                was most likely off, so there is nothing to check against
 */
export const judgeDay = ({ gpsKm, driverKm, returnLegKm = 0 }) => {
  const expectedKm = round1(driverKm + returnLegKm);
  const diffKm = round1(gpsKm - expectedKm);
  const tol = round1(toleranceKm(gpsKm));
  const diffPct = gpsKm > 0 ? round1((diffKm / gpsKm) * 100) : null;
  let status;
  if (gpsKm < 1 && driverKm >= MOVED_KM) status = 'no_gps';
  else if (Math.abs(diffKm) <= tol) status = 'ok';
  else status = diffKm > 0 ? 'driver_low' : 'driver_high';
  return { expectedKm, diffKm, diffPct, toleranceKm: tol, status };
};

/// Statuses that are an actual comparison (so they count towards accuracy).
const COMPARED = new Set(['ok', 'driver_low', 'driver_high']);
/// Statuses a manager should look at.
export const NEEDS_REVIEW = new Set(['driver_low', 'driver_high', 'no_trip', 'no_gps']);

/// How close the driver's km were to the GPS over these days: 100 − (all the differences,
/// ignoring which way, as a share of the GPS km). null when there is nothing to compare.
export const accuracyOf = (rows) => {
  const compared = rows.filter((r) => COMPARED.has(r.status));
  const gps = sum(compared, (r) => r.gpsKm);
  if (!compared.length || gps <= 0) return null;
  const off = sum(compared, (r) => Math.abs(r.diffKm));
  return Math.max(0, round1(100 - (off / gps) * 100));
};

// ── the whole comparison ────────────────────────────────────────────────────

const dayRange = (from, to) => {
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  return days;
};

const tripKm = (t) =>
  t.startKm != null && t.endKm != null && t.endKm >= t.startKm ? round1(t.endKm - t.startKm) : null;

/// The way home that the driver's trips did not record. A driver's day has ONE way home — it
/// belongs to the vehicle of his last trip of the day, whichever vehicle that was — so a driver
/// who changed vehicles is not charged for it twice. Summed over the drivers on this vehicle-day.
const returnLegOf = (trips, returnLegs, lastOfDriverDay) => {
  const lastPerDriver = new Map();
  for (const t of trips) {
    const k = t.driverId || '';
    const prev = lastPerDriver.get(k);
    if (!prev || new Date(t.at) >= new Date(prev.at)) lastPerDriver.set(k, t);
  }
  let km = 0;
  let source = 'none';
  for (const t of lastPerDriver.values()) {
    if (t.driverId && lastOfDriverDay.get(`${t.driverId}|${t.dayKey}`)?.bookingId !== t.bookingId) continue;
    const stored = t.driverId ? returnLegs.get(`${t.driverId}|${t.dayKey}`) : null;
    if (stored && stored.km > 0) {
      km += stored.km;
      source = 'route';
    } else if (t.travelDistanceKm > 0) {
      km += t.travelDistanceKm;
      if (source !== 'route') source = 'booking';
    }
  }
  return { km: round1(km), source: km > 0 ? source : 'none' };
};

/**
 * Compare the uploaded GPS km with the km drivers entered.
 *
 * @param {object} o
 * @param {string} o.from  'YYYY-MM-DD'
 * @param {string} o.to    'YYYY-MM-DD'
 * @param {Array}  o.readings  GPS rows [{ regKey, registrationNumber, dayKey, distanceKm,
 *                             runningHours, stopHours, idleHours, startAddress, endAddress }]
 * @param {Array}  o.vehicles  CRM vehicles [{ id, name, registrationNumber }]
 * @param {Array}  o.trips     completed trips [{ bookingId, bookingNumber, customerName, vehicleId,
 *                             driverId, driverName, startKm, endKm, dayKey, at, travelDistanceKm }]
 * @param {Map}    [o.returnLegs]  'driverId|dayKey' → { km } from the stored day routes
 */
export const buildGpsComparison = ({ from, to, readings, vehicles, trips, returnLegs = new Map() }) => {
  const byKey = new Map();
  for (const v of vehicles) {
    byKey.set(regKey(v.registrationNumber), v);
    // the GPS portal often names a vehicle by its plate, or by the name the CRM uses
    if (v.name && !byKey.has(regKey(v.name))) byKey.set(regKey(v.name), v);
  }

  // GPS rows per vehicle (CRM vehicle id, or the plate for one the CRM does not know)
  const gpsOf = new Map();
  const unmatched = new Map();
  for (const r of readings) {
    const v = byKey.get(r.regKey);
    if (!v) {
      const u = unmatched.get(r.regKey) ?? { registrationNumber: r.registrationNumber, days: 0, gpsKm: 0 };
      u.days += 1;
      u.gpsKm = round1(u.gpsKm + r.distanceKm);
      unmatched.set(r.regKey, u);
      continue;
    }
    if (!gpsOf.has(v.id)) gpsOf.set(v.id, new Map());
    gpsOf.get(v.id).set(r.dayKey, r);
  }

  const tripsOf = new Map();
  const lastOfDriverDay = new Map(); // 'driverId|dayKey' → the driver's last trip that day, any vehicle
  for (const t of trips) {
    if (!t.vehicleId || tripKm(t) === null) continue;
    if (t.driverId) {
      const k = `${t.driverId}|${t.dayKey}`;
      const prev = lastOfDriverDay.get(k);
      if (!prev || new Date(t.at) >= new Date(prev.at)) lastOfDriverDay.set(k, t);
    }
    if (!tripsOf.has(t.vehicleId)) tripsOf.set(t.vehicleId, new Map());
    const days = tripsOf.get(t.vehicleId);
    if (!days.has(t.dayKey)) days.set(t.dayKey, []);
    days.get(t.dayKey).push(t);
  }

  const days = [];
  const vehicleRows = [];
  const withoutGps = [];

  for (const v of vehicles) {
    const gps = gpsOf.get(v.id);
    const driver = tripsOf.get(v.id);
    if (!gps && !driver) continue;
    if (!gps) {
      const all = [...driver.values()].flat();
      withoutGps.push({
        vehicleId: v.id,
        registrationNumber: v.registrationNumber,
        name: v.name,
        trips: all.length,
        driverKm: round1(sum(all, tripKm)),
      });
      continue;
    }

    // Days the report has no row for are only "missing" between its first and last day —
    // before or after that the report simply does not cover the vehicle.
    const gpsDays = [...gps.keys()].sort();
    const first = gpsDays[0];
    const last = gpsDays[gpsDays.length - 1];
    const mine = [];

    for (const dayKey of dayRange(from, to)) {
      const reading = gps.get(dayKey);
      const dayTrips = driver?.get(dayKey) ?? [];
      if (!reading && !(dayTrips.length && dayKey >= first && dayKey <= last)) continue;

      const driverKm = round1(sum(dayTrips, tripKm));
      const drivers = [...new Map(dayTrips.map((t) => [t.driverId || '', t.driverName || ''])).entries()];
      const ret = dayTrips.length ? returnLegOf(dayTrips, returnLegs, lastOfDriverDay) : { km: 0, source: 'none' };

      const row = {
        date: dayKey,
        vehicleId: v.id,
        registrationNumber: v.registrationNumber,
        vehicleName: v.name,
        gpsKm: reading ? reading.distanceKm : null,
        driverKm: dayTrips.length ? driverKm : null,
        returnLegKm: ret.km,
        returnLegSource: ret.source,
        expectedKm: null,
        diffKm: null,
        diffPct: null,
        toleranceKm: null,
        status: '',
        reason: '',
        driverId: drivers.length === 1 ? drivers[0][0] : '',
        driverNames: drivers.map(([, name]) => name).filter(Boolean),
        trips: dayTrips.map((t) => ({
          bookingId: t.bookingId,
          bookingNumber: t.bookingNumber,
          customerName: t.customerName,
          driverName: t.driverName,
          startKm: t.startKm,
          endKm: t.endKm,
          km: tripKm(t),
        })),
        runningHours: reading?.runningHours ?? null,
        stopHours: reading?.stopHours ?? null,
        idleHours: reading?.idleHours ?? null,
        startAddress: reading?.startAddress ?? '',
        endAddress: reading?.endAddress ?? '',
      };

      if (reading && dayTrips.length) {
        const j = judgeDay({ gpsKm: reading.distanceKm, driverKm, returnLegKm: ret.km });
        Object.assign(row, j);
        if (j.status === 'no_gps') row.reason = 'zero';
      } else if (reading) {
        if (reading.distanceKm < MOVED_KM) continue; // parked — nothing to say
        row.status = 'no_trip';
      } else {
        row.status = 'no_gps';
        row.reason = 'missing';
      }
      mine.push(row);
    }

    days.push(...mine);
    const compared = mine.filter((r) => COMPARED.has(r.status));
    vehicleRows.push({
      vehicleId: v.id,
      registrationNumber: v.registrationNumber,
      name: v.name,
      gpsKm: round1(sum([...gps.values()].filter((r) => r.dayKey >= from && r.dayKey <= to), (r) => r.distanceKm)),
      comparedDays: compared.length,
      okDays: mine.filter((r) => r.status === 'ok').length,
      lowDays: mine.filter((r) => r.status === 'driver_low').length,
      highDays: mine.filter((r) => r.status === 'driver_high').length,
      noTripDays: mine.filter((r) => r.status === 'no_trip').length,
      noGpsDays: mine.filter((r) => r.status === 'no_gps').length,
      unloggedKm: round1(sum(mine.filter((r) => r.status === 'no_trip'), (r) => r.gpsKm)),
      netDiffKm: round1(sum(compared, (r) => r.diffKm)),
      accuracyPct: accuracyOf(mine),
    });
  }

  // Per driver — only days on which one driver used the vehicle, so nobody is judged on
  // another driver's odometer.
  const perDriver = new Map();
  for (const r of days) {
    if (!r.driverId || !COMPARED.has(r.status)) continue;
    if (!perDriver.has(r.driverId)) perDriver.set(r.driverId, { name: r.driverNames[0] ?? '', rows: [] });
    perDriver.get(r.driverId).rows.push(r);
  }
  const driverRows = [...perDriver.entries()].map(([driverId, { name, rows }]) => ({
    driverId,
    name,
    comparedDays: rows.length,
    okDays: rows.filter((r) => r.status === 'ok').length,
    lowDays: rows.filter((r) => r.status === 'driver_low').length,
    highDays: rows.filter((r) => r.status === 'driver_high').length,
    netDiffKm: round1(sum(rows, (r) => r.diffKm)),
    accuracyPct: accuracyOf(rows),
  }));

  // worst first: the ones to talk to
  const worstFirst = (a, b) => (a.accuracyPct ?? 101) - (b.accuracyPct ?? 101) || b.comparedDays - a.comparedDays;
  vehicleRows.sort(worstFirst);
  driverRows.sort(worstFirst);
  days.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.registrationNumber.localeCompare(b.registrationNumber)));

  const compared = days.filter((r) => COMPARED.has(r.status));
  return {
    from,
    to,
    tolerance: { ...TOLERANCE, movedKm: MOVED_KM },
    totals: {
      gpsKm: round1(sum(vehicleRows, (v) => v.gpsKm)),
      comparedGpsKm: round1(sum(compared, (r) => r.gpsKm)),
      comparedDriverKm: round1(sum(compared, (r) => r.driverKm)),
      comparedDays: compared.length,
      okDays: days.filter((r) => r.status === 'ok').length,
      lowDays: days.filter((r) => r.status === 'driver_low').length,
      highDays: days.filter((r) => r.status === 'driver_high').length,
      noTripDays: days.filter((r) => r.status === 'no_trip').length,
      noGpsDays: days.filter((r) => r.status === 'no_gps').length,
      reviewDays: days.filter((r) => NEEDS_REVIEW.has(r.status)).length,
      unloggedKm: round1(sum(days.filter((r) => r.status === 'no_trip'), (r) => r.gpsKm)),
      netDiffKm: round1(sum(compared, (r) => r.diffKm)),
      accuracyPct: accuracyOf(days),
    },
    vehicles: vehicleRows,
    drivers: driverRows,
    days,
    vehiclesWithoutGps: withoutGps.sort((a, b) => b.driverKm - a.driverKm),
    unmatchedGps: [...unmatched.values()].sort((a, b) => b.gpsKm - a.gpsKm),
  };
};
