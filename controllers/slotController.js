import SlotCapacity from '../models/SlotCapacity.js';
import Booking from '../models/Booking.js';
import BlockedDate from '../models/BlockedDate.js';
import { slotHalf, consumesSlot, dayKey } from '../utils/slots.js';

// HR (and full-access) manage capacity; any authenticated user may read it.
const MANAGE_ROLES = ['admin', 'manager', 'hr'];
const canManage = (u) => MANAGE_ROLES.includes(String(u?.role || '').toLowerCase());

const DEFAULT_MORNING = 3;
const DEFAULT_EVENING = 3;

// The single company-wide default row (created on first read).
const getDefaultRow = async () => {
  let def = await SlotCapacity.findOne({ date: null });
  if (!def) def = await SlotCapacity.create({ date: null, morning: DEFAULT_MORNING, evening: DEFAULT_EVENING });
  return def;
};

const clampInt = (v, fallback = 0) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

// @route GET /api/slots/defaults
export const getDefaults = async (req, res) => {
  try {
    const d = await getDefaultRow();
    res.json({ morning: d.morning, evening: d.evening });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// @route PUT /api/slots/defaults  (HR)
export const updateDefaults = async (req, res) => {
  if (!canManage(req.user)) return res.status(403).json({ message: 'Only HR can change slot capacity' });
  try {
    const morning = clampInt(req.body.morning, DEFAULT_MORNING);
    const evening = clampInt(req.body.evening, DEFAULT_EVENING);
    const d = await SlotCapacity.findOneAndUpdate(
      { date: null },
      { $set: { morning, evening } },
      { new: true, upsert: true }
    );
    res.json({ morning: d.morning, evening: d.evening });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// @route PUT /api/slots/day  (HR) — override one date's capacity
export const upsertDay = async (req, res) => {
  if (!canManage(req.user)) return res.status(403).json({ message: 'Only HR can change slot capacity' });
  try {
    const day = dayKey(req.body.date);
    if (Number.isNaN(day.getTime())) return res.status(400).json({ message: 'A valid date is required' });
    const morning = clampInt(req.body.morning, 0);
    const evening = clampInt(req.body.evening, 0);
    const doc = await SlotCapacity.findOneAndUpdate(
      { date: day },
      { $set: { morning, evening, note: String(req.body.note || '') } },
      { new: true, upsert: true }
    );
    res.json(doc);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// @route DELETE /api/slots/day?date=YYYY-MM-DD  (HR) — revert to default
export const clearDay = async (req, res) => {
  if (!canManage(req.user)) return res.status(403).json({ message: 'Only HR can change slot capacity' });
  try {
    const day = dayKey(req.query.date);
    if (Number.isNaN(day.getTime())) return res.status(400).json({ message: 'A valid date is required' });
    await SlotCapacity.deleteOne({ date: day });
    res.json({ message: 'Reverted to the default capacity' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// @route GET /api/slots/month?year=YYYY&month=1-12
// Per-day morning/evening capacity vs bookings, for the availability view.
export const getMonth = async (req, res) => {
  try {
    const year = Number(req.query.year);
    const month = Number(req.query.month); // 1-12
    if (!year || !month || month < 1 || month > 12) {
      return res.status(400).json({ message: 'year and month (1-12) are required' });
    }
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 1)); // exclusive

    const def = await getDefaultRow();
    const overrides = await SlotCapacity.find({ date: { $gte: start, $lt: end } }).lean();
    const capByDay = new Map(overrides.map((o) => [dayKey(o.date).toISOString(), o]));

    // HR-blocked dates for this month (the shared Blocked Dates list).
    const blockedRows = await BlockedDate.find({ active: true, date: { $gte: start, $lt: end } })
      .select('date')
      .lean();
    const blockedSet = new Set(blockedRows.map((b) => dayKey(b.date).toISOString()));

    const bookings = await Booking.find({ bookingDate: { $gte: start, $lt: end } })
      .select('bookingDate eventSlot status')
      .lean();
    const booked = new Map(); // dayIso -> { morning, evening }
    for (const b of bookings) {
      if (!consumesSlot(b)) continue;
      const k = dayKey(b.bookingDate).toISOString();
      const half = slotHalf(b.eventSlot);
      const cur = booked.get(k) || { morning: 0, evening: 0 };
      cur[half] += 1;
      booked.set(k, cur);
    }

    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const days = [];
    for (let d = 1; d <= daysInMonth; d += 1) {
      const day = new Date(Date.UTC(year, month - 1, d));
      const k = day.toISOString();
      const cap = capByDay.get(k) || def;
      const bk = booked.get(k) || { morning: 0, evening: 0 };
      const blocked = blockedSet.has(k);
      const totalCap = (cap.morning || 0) + (cap.evening || 0);
      const totalBk = bk.morning + bk.evening;
      days.push({
        date: day.toISOString().slice(0, 10),
        isOverride: capByDay.has(k),
        blocked,
        morning: { capacity: cap.morning, booked: bk.morning, available: Math.max(0, cap.morning - bk.morning) },
        evening: { capacity: cap.evening, booked: bk.evening, available: Math.max(0, cap.evening - bk.evening) },
        // Full when total bookings reach total capacity — or the day is HR-blocked.
        total: { capacity: totalCap, booked: totalBk, available: blocked ? 0 : Math.max(0, totalCap - totalBk) },
      });
    }
    const totalCapacity = days.reduce((s, x) => s + x.total.capacity, 0);
    const totalAvailable = days.reduce((s, x) => s + x.total.available, 0);
    const totalBooked = days.reduce((s, x) => s + x.total.booked, 0);
    res.json({
      year,
      month,
      defaults: { morning: def.morning, evening: def.evening },
      totalCapacity,
      totalAvailable,
      totalBooked,
      days,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// Shared capacity check used by booking creation. A day is full when the TOTAL
// bookings on it reach the day's total capacity (morning + evening) — e.g. a
// 15/5 day allows 20 bookings in any mix. Returns { full, capacity, booked }.
// `excludeBookingId` lets an edit ignore its own booking.
export const slotAvailability = async (bookingDate, _eventSlot, excludeBookingId = null) => {
  if (!bookingDate) return { full: false };
  const day = dayKey(bookingDate);
  if (Number.isNaN(day.getTime())) return { full: false };

  const override = await SlotCapacity.findOne({ date: day }).lean();
  let capacity;
  if (override) capacity = (override.morning || 0) + (override.evening || 0);
  else {
    const def = await SlotCapacity.findOne({ date: null }).lean();
    capacity = def ? (def.morning + def.evening) : (DEFAULT_MORNING + DEFAULT_EVENING);
  }

  const end = new Date(day.getTime() + 24 * 60 * 60 * 1000);

  // HR-blocked dates (the Blocked Dates list) take no bookings at all.
  const blocked = !!(await BlockedDate.exists({ active: true, date: { $gte: day, $lt: end } }));

  const filter = { bookingDate: { $gte: day, $lt: end } };
  if (excludeBookingId) filter._id = { $ne: excludeBookingId };
  const sameDay = await Booking.find(filter).select('status').lean();
  const booked = sameDay.filter(consumesSlot).length;

  return { full: blocked || booked >= capacity, blocked, capacity, booked };
};
