import asyncHandler from 'express-async-handler';
import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import { AllocationRefusal, allocationMetrics, bookingAllocationStatus, previewAllocation, confirmAllocation, confirmMany, dayBoard, decideExtra, loadAllocationState, releaseUnit, suggestForBooking } from '../services/artistAllocation.js';
import { autoOn, cleanSettingsInput, getAllocationSettings, guardOn, modeOf, saveAllocationSettings } from '../services/allocationSettings.js';
import { mayAllocate, mayChangeAllocationMode, mayEditAllocationSettings, mayViewBookingAllocation } from '../utils/allocationAccess.js';
import * as A from '../utils/artistAllocation.js';
import { addDays, isDay, todayIst } from '../utils/istDate.js';

// /api/allocation — the smart booking allocation (rules: utils/artistAllocation.js; the work: services/artistAllocation.js).

const refuse = (res, e) => {
  if (!(e instanceof AllocationRefusal)) throw e;
  return res.status(e.status).json({ message: e.message, code: e.code, ...e.extra });
};
const run = (fn) => asyncHandler(async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    refuse(res, e);
  }
});

const settingsView = (s, user) => ({
  ...A.normalizeSettings(s),
  mode: modeOf(s),
  savedMode: s.mode,
  guard: s.guard,
  guardOn: guardOn(s),
  autoAllocate: s.autoAllocate ?? 'off',
  autoOn: autoOn(s),
  liveSince: s.liveSince ?? null,
  shadowSince: s.shadowSince ?? null,
  updatedByName: s.updatedByName ?? '',
  updatedAt: s.updatedAt ?? null,
  canEdit: mayEditAllocationSettings(user),
  canChangeMode: mayChangeAllocationMode(user),
  canAllocate: modeOf(s) === 'suggest' && mayAllocate(user),
});

// @route GET /api/allocation/settings
export const getSettings = run(async (req, res) => {
  res.json(settingsView(await getAllocationSettings(), req.user));
});

// @route PUT /api/allocation/settings
export const putSettings = run(async (req, res) => {
  if (!mayEditAllocationSettings(req.user)) return res.status(403).json({ message: 'Only the Artist Head, the CRM Head or a manager can change the allocation rules.' });
  const v = cleanSettingsInput(req.body ?? {}, { mayChangeMode: mayChangeAllocationMode(req.user) });
  if (!v.ok) return res.status(v.message.startsWith('Only') ? 403 : 400).json({ message: v.message });
  res.json(settingsView(await saveAllocationSettings(v.value, req.user), req.user));
});

// @route GET /api/allocation/booking/:id — the teams ranked for each package of a booking
export const getBookingSuggestions = run(async (req, res) => {
  res.json(await suggestForBooking(req.params.id, req.user));
});

// @route GET /api/allocation/booking/:id/status — who has each package of a booking, or why it waits (the salespeople read it too)
export const getBookingStatus = run(async (req, res) => {
  if (!mayViewBookingAllocation(req.user)) return res.status(403).json({ message: 'The allocation is for the CRM team, the Artist Head, managers and sales.' });
  res.json(await bookingAllocationStatus(req.params.id));
});

// @route POST /api/allocation/preview — the Add Booking form: who would take this booking (not saved yet); the salespeople use it too
export const previewBooking = run(async (req, res) => {
  if (!mayViewBookingAllocation(req.user)) return res.status(403).json({ message: 'The allocation is for the CRM team, the Artist Head, managers and sales.' });
  res.json(await previewAllocation(req.body ?? {}, req.user));
});

// @route POST /api/allocation/plan { bookingIds } — suggestions for several bookings at once (bulk confirm), nothing written
export const planMany = run(async (req, res) => {
  const ids = [...new Set((Array.isArray(req.body?.bookingIds) ? req.body.bookingIds : []).map(String))].filter((x) => mongoose.isValidObjectId(x)).slice(0, 60);
  if (!ids.length) return res.status(400).json({ message: 'Choose the bookings.' });
  const settings = await getAllocationSettings();
  const bookings = await Booking.find({ _id: { $in: ids } }).select('bookingNumber customerName status selectedDates bookingDate serviceStart serviceEnd eventSlot service pincode address district region districtId mapUrl dateMaps bookingItems assignedStaff statusHistory updatedAt').lean();
  const days = [...new Set(bookings.flatMap((b) => A.workUnits(b, {}, settings).flatMap((u) => u.days.map((d) => d.day))))];
  const { state, ctx } = await loadAllocationState({ days, targets: bookings });
  const units = bookings.flatMap((b) => A.workUnits(b, ctx, settings));
  const { plan } = A.planUnits({ units, state, settings });
  res.json({
    items: plan.map(({ unit, candidates, pick }) => ({
      bookingId: unit.bookingId, bookingNumber: unit.bookingNumber, customerName: unit.customerName, unitKey: unit.unitKey, label: unit.label,
      days: unit.days.map((d) => ({ day: d.day, start: d.start, half: d.half, place: { label: d.place.label, precision: d.place.precision } })),
      pick: pick ? { teamId: pick.teamId, teamName: pick.teamName, tier: pick.tier, reason: pick.reason } : null,
      candidates: candidates.slice(0, 6),
    })),
  });
});

// @route POST /api/allocation/confirm { bookingId, bookingUpdatedAt, picks: [{ unitKey, teamId, assistantIds?, overrideReason? }], source }
export const confirm = run(async (req, res) => {
  const b = req.body ?? {};
  const r = await confirmAllocation({ user: req.user, bookingId: b.bookingId, bookingUpdatedAt: b.bookingUpdatedAt ?? null, picks: b.picks ?? [], source: String(b.source ?? 'requests').slice(0, 20), confirmConflicts: req.get('X-Confirm-Artist-Conflict') === '1' });
  res.json(r);
});

// @route POST /api/allocation/confirm-many { items: [{ bookingId, picks }] }
export const confirmSeveral = run(async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 60) : [];
  if (!items.length) return res.status(400).json({ message: 'Nothing to allocate.' });
  res.json({ results: await confirmMany({ user: req.user, items, source: 'bulk' }) });
});

// @route POST /api/allocation/:id/approve | /reject { note }
export const approveExtra = run(async (req, res) => res.json(await decideExtra({ allocationId: req.params.id, approve: true, user: req.user, note: req.body?.note })));
export const rejectExtra = run(async (req, res) => res.json(await decideExtra({ allocationId: req.params.id, approve: false, user: req.user, note: req.body?.note })));

// @route POST /api/allocation/release { bookingId, unitKey }
export const release = run(async (req, res) => {
  if (!mongoose.isValidObjectId(req.body?.bookingId)) return res.status(400).json({ message: 'That booking was not found.' });
  res.json(await releaseUnit({ bookingId: req.body.bookingId, unitKey: req.body.unitKey, user: req.user }));
});

// @route GET /api/allocation/day?date=YYYY-MM-DD — the Allocation Board
export const getDay = run(async (req, res) => {
  const day = isDay(req.query.date) ? String(req.query.date) : todayIst();
  res.json(await dayBoard(day, req.user));
});

// @route GET /api/allocation/metrics?from&to
export const getMetrics = run(async (req, res) => {
  const to = isDay(req.query.to) ? String(req.query.to) : todayIst();
  const from = isDay(req.query.from) ? String(req.query.from) : addDays(to, -29);
  if (from > to) return res.status(400).json({ message: 'The start is after the end.' });
  res.json(await allocationMetrics({ from, to }));
});
