import Booking from '../models/Booking.js';
import CrmBookingCare from '../models/CrmBookingCare.js';
import { crmViewerOf } from '../utils/crmAccess.js';
import { cleanMedical, eventDaysOf, hasMark, isWorkDay, mayReadCare, setMark, worksBetween } from '../utils/crmCare.js';
import { addDays, isDay, istDayKey } from '../utils/istDate.js';
import { careSince } from '../services/crmSettings.js';
import { fail, idOf, isId, lc, mayWrite, requireWriter, route } from './crmHttp.js';

// The CRM's care of one booking (/api/crm/care/:bookingId): "verified with the client" and "photos collected" per work day, the client's
// medical conditions and emergencies — and the to-do lists of works still to verify / to collect photos for.
//
// Who: the CRM team, management and leadership read (leadership only reads); the CRM team and management change. The people working
// a booking (its artists) READ its medical notes and emergencies — they must know before they start — and nothing else.

const BOOKING_FIELDS = 'bookingNumber customerName phone status serviceStart bookingDate selectedDates bookingItems.selectedDates assignedStaff.employeeId bookingItems.assignedStaff.employeeId';

const loadBooking = async (id) => {
  if (!isId(id)) fail(404, 'Booking not found.');
  const b = await Booking.findById(id).select(BOOKING_FIELDS).lean();
  if (!b) fail(404, 'Booking not found.');
  return b;
};

const careView = (booking, care, { full }) => {
  const medical = {
    conditions: care?.medical?.conditions ?? [],
    note: care?.medical?.note ?? '',
    updatedAt: care?.medical?.updatedAt ?? null,
    updatedByName: care?.medical?.updatedByName ?? '',
  };
  const emergencies = (care?.emergencies ?? []).map((e) => ({ id: idOf(e), day: e.day, at: e.at, what: e.what, action: e.action ?? '', byName: e.byName ?? '' }));
  const base = { bookingId: idOf(booking), bookingNumber: booking.bookingNumber ?? '', client: booking.customerName ?? '', days: eventDaysOf(booking), medical, emergencies };
  if (!full) return base;
  const mark = (list) => (list ?? []).map((m) => ({ day: m.day, at: m.at, byName: m.byName ?? '', note: m.note ?? '' }));
  return { ...base, verifications: mark(care?.verifications), photos: mark(care?.photos) };
};

// @route GET /api/crm/care/:bookingId — the CRM team and management see everything; the booking's own artists see its medical notes.
export const getCare = route(async (req, res) => {
  const booking = await loadBooking(req.params.bookingId);
  const viewer = crmViewerOf(req.user);
  if (!mayReadCare({ viewer, employeeId: req.user?.employeeId, booking })) fail(403, 'Only the CRM team and the people working this booking can see this.');
  const care = await CrmBookingCare.findOne({ bookingId: booking._id }).lean();
  res.json({ ...careView(booking, care, { full: viewer !== 'none' }), canWrite: mayWrite(viewer) });
});

/// The care record of [booking], made when first needed.
const careDoc = async (booking) => {
  await careSince(); // the day these records began (the weekly report says "—" before)
  return CrmBookingCare.findOneAndUpdate({ bookingId: booking._id }, { $setOnInsert: { bookingId: booking._id } }, { upsert: true, new: true });
};

const tick = (field, { futureAllowed }) =>
  route(async (req, res) => {
    requireWriter(req);
    const booking = await loadBooking(req.params.bookingId);
    const day = String(req.body?.day ?? '').trim();
    if (!isWorkDay(booking, day)) fail(400, `${day || 'That day'} is not one of this booking's work days.`);
    if (!futureAllowed && day > istDayKey(new Date())) fail(400, 'That work has not happened yet.');
    const done = req.body?.done !== false;
    const care = await careDoc(booking);
    const { marks, changed } = setMark(care[field], day, done, { user: req.user, note: req.body?.note });
    if (changed) {
      care[field] = marks;
      await care.save();
    }
    res.json({ ...careView(booking, care.toObject(), { full: true }), canWrite: true });
  });

// @route PUT /api/crm/care/:bookingId/verify { day, done, note } — the work of [day] was verified with the client (done:false takes it back)
export const verifyDay = tick('verifications', { futureAllowed: true });
// @route PUT /api/crm/care/:bookingId/photos { day, done, note } — the photos of [day]'s work were collected
export const photosDay = tick('photos', { futureAllowed: false });

// @route PUT /api/crm/care/:bookingId/medical { conditions: [allergy|skin|pregnancy|other], note }
export const setMedical = route(async (req, res) => {
  requireWriter(req);
  const booking = await loadBooking(req.params.bookingId);
  const m = cleanMedical(req.body ?? {});
  if (m.error) fail(400, m.error);
  const care = await careDoc(booking);
  care.medical = { conditions: m.conditions, note: m.note, updatedAt: new Date(), updatedBy: req.user._id, updatedByName: req.user.name || '' };
  await care.save();
  res.json({ ...careView(booking, care.toObject(), { full: true }), canWrite: true });
});

// @route POST /api/crm/care/:bookingId/emergencies { day, what, action }
export const addEmergency = route(async (req, res) => {
  requireWriter(req);
  const booking = await loadBooking(req.params.bookingId);
  const day = String(req.body?.day ?? '').trim();
  if (!isWorkDay(booking, day)) fail(400, 'Choose the work day it happened on.');
  if (day > istDayKey(new Date())) fail(400, 'That work has not happened yet.');
  const what = String(req.body?.what ?? '').trim().slice(0, 1000);
  if (what.length < 3) fail(400, 'Say what happened.');
  const care = await careDoc(booking);
  if (care.emergencies.length >= 50) fail(400, 'This booking has too many emergencies logged.');
  care.emergencies.push({ day, at: new Date(), what, action: String(req.body?.action ?? '').trim().slice(0, 1000), by: req.user._id, byName: req.user.name || '' });
  await care.save();
  res.status(201).json({ ...careView(booking, care.toObject(), { full: true }), canWrite: true });
});

const LIST_FIELDS = 'bookingNumber customerName phone status serviceStart bookingDate selectedDates bookingItems.selectedDates';
const LIST_MAX_DAYS = 31;

/**
 * @route GET /api/crm/care-list?kind=verify|photos&from&to — the works in a stretch of days with their tick:
 *   verify: from today to 7 days ahead (the works to call the clients about); photos: the last 14 days up to today (works done).
 * → { kind, from, to, works, done, items: [{ bookingId, bookingNumber, client, phone, day, done, byName, at, medical }] }
 */
export const careList = route(async (req, res) => {
  const kind = lc(req.query.kind) || 'verify';
  if (!['verify', 'photos'].includes(kind)) fail(400, 'kind must be verify or photos.');
  const today = istDayKey(new Date());
  const from = isDay(req.query.from) ? req.query.from : kind === 'verify' ? today : addDays(today, -13);
  let to = isDay(req.query.to) ? req.query.to : kind === 'verify' ? addDays(today, 7) : today;
  if (kind === 'photos' && to > today) to = today;
  if (to < from) fail(400, 'The end is before the start.');
  if (addDays(from, LIST_MAX_DAYS) < to) fail(400, `Choose at most ${LIST_MAX_DAYS} days.`);
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  const bookings = await Booking.find({
    $or: [{ selectedDates: { $in: days } }, { 'bookingItems.selectedDates': { $in: days } }, { serviceStart: { $gte: new Date(`${from}T00:00:00+05:30`), $lte: new Date(`${to}T23:59:59.999+05:30`) } }],
  })
    .select(LIST_FIELDS)
    .lean();
  const works = worksBetween(bookings, from, to);
  const cares = works.length ? await CrmBookingCare.find({ bookingId: { $in: [...new Set(works.map((w) => w.booking._id))] } }).lean() : [];
  const careOf = new Map(cares.map((c) => [idOf(c.bookingId), c]));
  const field = kind === 'verify' ? 'verifications' : 'photos';
  const items = works.map(({ booking, day }) => {
    const care = careOf.get(idOf(booking));
    const mark = (care?.[field] ?? []).find((m) => m.day === day);
    return {
      bookingId: idOf(booking),
      bookingNumber: booking.bookingNumber ?? '',
      client: booking.customerName ?? '',
      phone: booking.phone ?? '',
      day,
      done: hasMark(care?.[field], day),
      byName: mark?.byName ?? '',
      at: mark?.at ?? null,
      medical: (care?.medical?.conditions ?? []).length > 0,
    };
  });
  res.json({ kind, from, to, works: items.length, done: items.filter((i) => i.done).length, items });
});
