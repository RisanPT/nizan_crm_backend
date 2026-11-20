import asyncHandler from 'express-async-handler';
import Employee from '../models/Employee.js';
import Booking from '../models/Booking.js';
import { isFullAccess } from '../utils/hrAccess.js';
import { findOrCreateAssociate } from './associateController.js';
import { buildRows, isPending, keyOf, parseTempStaff } from '../utils/tempStaffNames.js';
import { isCrmRole } from '../utils/crmAccess.js';

// CONVERT THE OLD "TEMPORARY STAFF" BOX INTO ASSOCIATES — a one-time review of the names Operations typed into a booking's free-text
// temporary-staff box, so those works reach the Associate Works report like any other. The reading rules are in utils/tempStaffNames.js.
//
//   GET  /api/associate-works/temp-staff           the review list: one row per person typed, how many bookings, the spellings, a role hint
//   POST /api/associate-works/temp-staff/convert   apply what a person decided for each row (create / link / merge / skip)
//
// Nothing is guessed: spelling variants are only SUGGESTED as the same person, and nothing changes until a person confirms. Converting
// puts the associate on the booking's team (the booking AND each of its packages, like an associate added by hand), leaves the typed text
// as it was, and marks the booking so it is not offered again (a later edit of the text brings it back).

const bad = (res, message, status = 400) => {
  res.status(status);
  throw new Error(message);
};

const roleOf = (u) => String(u?.role ?? '').trim().toLowerCase();

// Operations (CRM), managers and admins — the people who put associates on a work. It rewrites many bookings at once, so it is narrower than
// the one-at-a-time quick-add (which anyone who works with bookings may use, e.g. sales). Leadership (read-only) is not on this list.
const canConvert = (u) => isFullAccess(u) || isCrmRole(u);

const ACTIONS = ['create', 'link', 'merge', 'skip'];
const MAX_ROWS = 500;
const PICK = 'bookingNumber customerName status serviceStart selectedDates temporaryStaffDetails tempStaffConverted assignedStaff bookingItems.assignedStaff';

const pendingBookings = () => Booking.find({ temporaryStaffDetails: { $regex: /\S/ } }).select(PICK).lean();

// @desc   The review list for the old temporary-staff box.
// @route  GET /api/associate-works/temp-staff
// @access Private — Operations (CRM), managers, admins
// @returns { pendingBookings, rows[{ key, name, variants, roleHint, phone, count, samples, similar, suggestion }], associates[{ id, name, phone, status }] }
export const getTempStaff = asyncHandler(async (req, res) => {
  if (!canConvert(req.user)) bad(res, 'You are not allowed to convert temporary staff.', 403);
  const [bookings, associates] = await Promise.all([pendingBookings(), Employee.find({ isAssociate: true }).select('name phone status').sort({ name: 1 }).lean()]);
  const { pendingBookings: n, rows } = buildRows(bookings, associates);
  res.json({ pendingBookings: n, rows, associates: associates.map((a) => ({ id: String(a._id), name: a.name, phone: a.phone ?? '', status: a.status })) });
});

const assignmentFor = (employee, role) => ({
  employeeId: employee._id,
  artistName: employee.name,
  role: role || 'Associate',
  specialization: employee.specialization ?? '',
  works: employee.works ?? [],
  phone: employee.phone ?? '',
  type: 'outsource',
  roleType: 'assistant',
});

const onTeam = (list, id) => (list ?? []).some((a) => String(a.employeeId) === String(id));

// @desc   Apply the reviewed rows. Body { rows: [{ key, action: create|link|merge|skip, name?, phone?, role?, employeeId?, into? }] }
//         create = a new associate (or the one with that phone / that exact name); link = an existing associate (employeeId);
//         merge = the same person as another row of this request (into = its key; that row must be a create or a link); skip = not an associate.
//         Rows left out of the request stay for later. Safe to repeat: nobody is added twice.
// @route  POST /api/associate-works/temp-staff/convert
// @access Private — Operations (CRM), managers, admins
// @returns { created, linked, reused, bookingsUpdated, bookingsReviewed, assignmentsAdded, skipped, errors[{ key, message }] }
export const convertTempStaff = asyncHandler(async (req, res) => {
  if (!canConvert(req.user)) bad(res, 'You are not allowed to convert temporary staff.', 403);
  const asked = req.body?.rows;
  if (!Array.isArray(asked) || !asked.length) bad(res, 'Choose what to do with at least one name.');
  if (asked.length > MAX_ROWS) bad(res, `Convert at most ${MAX_ROWS} names at a time.`);

  const byKey = new Map();
  for (const r of asked) {
    const key = keyOf(r?.key);
    if (!key) bad(res, 'Every row needs its key.');
    if (byKey.has(key)) bad(res, `The name "${r.key}" is in the list twice.`);
    const action = String(r.action ?? '');
    if (!ACTIONS.includes(action)) bad(res, `Row "${r.key}": action must be create, link, merge or skip.`);
    byKey.set(key, { ...r, key, action });
  }

  // Everything below works from a FRESH read, never from what the screen remembers.
  const bookings = (await pendingBookings()).filter(isPending);
  const present = new Set();
  const parsed = new Map(); // bookingId → [{ key, role }]
  for (const b of bookings) {
    const people = parseTempStaff(b.temporaryStaffDetails).filter((p) => byKey.has(p.key));
    for (const p of people) present.add(p.key);
    if (people.length) parsed.set(String(b._id), people);
  }

  const errors = [];
  const fail = (key, message) => errors.push({ key, message });
  const resolved = new Map(); // key → { employee, role }
  const counts = { created: 0, linked: 0, reused: 0, skipped: 0 };

  // 1. create / link first
  for (const row of byKey.values()) {
    if (!present.has(row.key) && row.action !== 'skip') { fail(row.key, 'No booking has this name any more (already converted, or the text was edited).'); continue; }
    const role = String(row.role ?? '').trim().slice(0, 40);
    if (row.action === 'create') {
      const name = String(row.name ?? '').trim().replace(/\s+/g, ' ');
      if (name.length < 2 || name.length > 80) { fail(row.key, "Give the associate's name (2 to 80 letters)."); continue; }
      const phone = String(row.phone ?? '').trim();
      const d = phone.replace(/\D/g, '');
      if (phone && (d.length < 7 || d.length > 15)) { fail(row.key, 'The phone number does not look right.'); continue; }
      // no phone to match on: the same name already registered is the same person (so converting twice never doubles people)
      const sameName = d.length < 7 ? (await Employee.find({ isAssociate: true }).lean()).find((e) => keyOf(e.name) === keyOf(name)) : null;
      if (sameName) { resolved.set(row.key, { employee: sameName, role }); counts.reused += 1; continue; }
      const made = await findOrCreateAssociate({ name, phone, specialization: role });
      if (made.conflict) { fail(row.key, `This number already belongs to ${made.conflict.name}, who is on the team and not an associate.`); continue; }
      resolved.set(row.key, { employee: made.employee, role });
      if (made.existing) counts.reused += 1; else counts.created += 1;
    } else if (row.action === 'link') {
      const id = String(row.employeeId ?? '');
      const employee = /^[0-9a-f]{24}$/i.test(id) ? await Employee.findById(id).lean() : null;
      if (!employee || employee.isAssociate !== true) { fail(row.key, 'Pick a registered associate to link this name to.'); continue; }
      resolved.set(row.key, { employee, role });
      counts.linked += 1;
    } else if (row.action === 'skip') {
      counts.skipped += 1;
    }
  }
  // 2. merge → the person another row resolved to
  for (const row of byKey.values()) {
    if (row.action !== 'merge') continue;
    const target = byKey.get(keyOf(row.into));
    if (!target || !['create', 'link'].includes(target.action)) { fail(row.key, 'Choose which person this is the same as.'); continue; }
    const who = resolved.get(target.key);
    if (!who) { fail(row.key, `"${target.name ?? target.key}" could not be added, so this name could not be merged into it.`); continue; }
    resolved.set(row.key, { employee: who.employee, role: String(row.role ?? '').trim().slice(0, 40) || who.role });
  }

  // 3. one write per booking: the associates it names go on its team (the booking and each package), and the booking is marked reviewed
  let bookingsUpdated = 0;
  let bookingsReviewed = 0;
  let assignmentsAdded = 0;
  const now = new Date();
  for (const b of bookings) {
    const people = parsed.get(String(b._id));
    if (!people) continue;
    // a row that failed to resolve leaves the booking for another try; skipped / resolved rows are settled
    const unsettled = people.some((p) => byKey.get(p.key).action !== 'skip' && !resolved.has(p.key));
    const add = [];
    for (const p of people) {
      const who = resolved.get(p.key);
      if (who && !add.some((a) => String(a.employee._id) === String(who.employee._id))) add.push({ employee: who.employee, role: who.role || p.role });
    }
    const $push = {};
    let added = 0;
    const missingAtBooking = add.filter((a) => !onTeam(b.assignedStaff, a.employee._id));
    if (missingAtBooking.length) { $push.assignedStaff = { $each: missingAtBooking.map((a) => assignmentFor(a.employee, a.role)) }; added += missingAtBooking.length; }
    (b.bookingItems ?? []).forEach((item, i) => {
      const missing = add.filter((a) => !onTeam(item.assignedStaff, a.employee._id));
      if (missing.length) { $push[`bookingItems.${i}.assignedStaff`] = { $each: missing.map((a) => assignmentFor(a.employee, a.role)) }; added += missing.length; }
    });
    const update = {};
    if (Object.keys($push).length) update.$push = $push;
    if (!unsettled) update.$set = { tempStaffConverted: { at: now, by: req.user._id, text: String(b.temporaryStaffDetails) } };
    if (!Object.keys(update).length) continue;
    // only if the text is still what we read — somebody may have edited it since we read it (a guard for a race that a test cannot stage)
    const done = await Booking.updateOne({ _id: b._id, temporaryStaffDetails: b.temporaryStaffDetails }, update);
    if (!done.matchedCount) continue;
    if (update.$push) { bookingsUpdated += 1; assignmentsAdded += added; }
    if (update.$set) bookingsReviewed += 1;
  }

  res.json({ ...counts, bookingsUpdated, bookingsReviewed, assignmentsAdded, errors });
});
