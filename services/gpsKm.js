import Booking from '../models/Booking.js';
import DayTrip from '../models/DayTrip.js';
import GpsKmReading from '../models/GpsKmReading.js';
import GpsKmUpload from '../models/GpsKmUpload.js';
import Vehicle from '../models/Vehicle.js';
import { buildGpsComparison, regKey } from '../utils/gpsKm.js';
import { istDayKey, istStart, istEnd } from '../utils/istDate.js';

const SAME = 0.005; // km — a re-upload of the same figure is not a change

const changed = (old, row) =>
  Math.abs(old.distanceKm - row.distanceKm) > SAME ||
  ['runningHours', 'stopHours', 'idleHours', 'startAddress', 'endAddress'].some((k) => (old[k] ?? null) !== (row[k] ?? null));

const asVehicle = (v) => ({ id: String(v._id), name: v.name ?? '', registrationNumber: v.registrationNumber ?? '' });

/**
 * Save clean rows (utils/gpsKm.js cleanGpsRows). A vehicle-day that is already there is
 * updated, so overlapping reports can be uploaded again safely.
 * @returns {{ upload, created, updated, unchanged }}
 */
export const saveGpsRows = async ({ rows, skipped, fileName, user }) => {
  const days = rows.map((r) => r.dayKey).sort();
  const vehicles = (await Vehicle.find().select('name registrationNumber').lean()).map(asVehicle);
  const crmKeys = new Map();
  for (const v of vehicles) {
    crmKeys.set(regKey(v.registrationNumber), v);
    if (v.name && !crmKeys.has(regKey(v.name))) crmKeys.set(regKey(v.name), v);
  }

  const existing = rows.length
    ? await GpsKmReading.find({ regKey: { $in: [...new Set(rows.map((r) => r.regKey))] }, dayKey: { $gte: days[0], $lte: days[days.length - 1] } }).lean()
    : [];
  const had = new Map(existing.map((e) => [`${e.regKey}|${e.dayKey}`, e]));

  const perVehicle = new Map();
  for (const r of rows) {
    const p = perVehicle.get(r.regKey) ?? { registrationNumber: r.registrationNumber, vehicleName: crmKeys.get(r.regKey)?.name ?? '', days: 0 };
    p.days += 1;
    perVehicle.set(r.regKey, p);
  }

  const upload = await GpsKmUpload.create({
    fileName: String(fileName ?? '').slice(0, 200),
    uploadedBy: user?._id ?? null,
    uploadedByName: user?.name ?? '',
    from: days[0] ?? '',
    to: days[days.length - 1] ?? '',
    rows: rows.length,
    skipped,
    vehicles: [...perVehicle.values()],
  });

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  const ops = [];
  for (const r of rows) {
    const old = had.get(`${r.regKey}|${r.dayKey}`);
    if (!old) created += 1;
    else if (changed(old, r)) updated += 1;
    else {
      unchanged += 1;
      continue;
    }
    ops.push({
      updateOne: {
        filter: { regKey: r.regKey, dayKey: r.dayKey },
        update: { $set: { ...r, uploadId: upload._id } },
        upsert: true,
      },
    });
  }
  if (ops.length) await GpsKmReading.bulkWrite(ops, { ordered: false });

  upload.created = created;
  upload.updated = updated;
  upload.unchanged = unchanged;
  await upload.save();
  return { upload, created, updated, unchanged };
};

/// The most recent uploads, newest first.
export const recentUploads = (limit = 5) => GpsKmUpload.find().sort({ createdAt: -1 }).limit(limit).lean();

/**
 * GPS km against the km the drivers entered, for 'YYYY-MM-DD' from…to (both inclusive).
 * [vehicleId] limits it to one vehicle.
 */
export const compareGpsKm = async ({ from, to, vehicleId = null }) => {
  const start = istStart(from);
  const end = istEnd(to);

  const vehicles = (await Vehicle.find(vehicleId ? { _id: vehicleId } : {}).select('name registrationNumber').lean()).map(asVehicle);
  const readings = await GpsKmReading.find({ dayKey: { $gte: from, $lte: to } }).lean();

  const trips = (await Booking.find({
    tripStatus: 'completed',
    vehicleId: vehicleId ?? { $ne: null },
    startKm: { $ne: null },
    endKm: { $ne: null },
    $or: [
      { tripStartedAt: { $gte: start, $lte: end } },
      { tripStartedAt: null, tripCompletedAt: { $gte: start, $lte: end } },
    ],
  })
    .select('bookingNumber customerName driverId vehicleId startKm endKm tripStartedAt tripCompletedAt travelDistanceKm')
    .populate('driverId', 'name')
    .lean()).map((b) => {
    const at = b.tripStartedAt ?? b.tripCompletedAt;
    return {
      bookingId: String(b._id),
      bookingNumber: b.bookingNumber ?? '',
      customerName: b.customerName ?? '',
      vehicleId: b.vehicleId ? String(b.vehicleId) : '',
      driverId: b.driverId?._id ? String(b.driverId._id) : '',
      driverName: b.driverId?.name ?? '',
      startKm: b.startKm,
      endKm: b.endKm,
      dayKey: istDayKey(at),
      at,
      travelDistanceKm: b.travelDistanceKm || 0,
    };
  });

  // The way home isn't on any odometer: take it from the day's stored route, when there is one.
  const returnLegs = new Map();
  const driverIds = [...new Set(trips.map((t) => t.driverId).filter(Boolean))];
  if (driverIds.length) {
    const plans = await DayTrip.find({ driverId: { $in: driverIds }, dayKey: { $gte: from, $lte: to } })
      .select('driverId dayKey legs planError')
      .lean();
    for (const p of plans) {
      if (p.planError) continue;
      const leg = (p.legs || []).filter((l) => l.kind === 'return' && l.km !== null);
      const km = leg.reduce((s, l) => s + (l.km || 0), 0);
      if (km > 0) returnLegs.set(`${p.driverId}|${p.dayKey}`, { km });
    }
  }

  return buildGpsComparison({ from, to, readings, vehicles, trips, returnLegs });
};
