import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import { loadAllocationState } from '../services/artistAllocation.js';
import { getAllocationSettings, guardOn, isNewBooking } from '../services/allocationSettings.js';
import * as A from '../utils/artistAllocation.js';
import { staffByUnit } from '../utils/bookingStaff.js';

// ARTIST GUARD — in front of booking create / update, for NEW bookings only (made or confirmed after the allocation went live), when the
// allocation's clash check is on (Allocation settings → guard, and suggest mode). When a save PUTS someone on a package — a lead who is
// already on another work then, on leave, no longer active, or whose slots in that half are full (an EXTRA needs the Artist Head) —
// it is answered 409 ARTIST_CONFLICT instead, unless the app repeats it with
//   X-Confirm-Artist-Conflict: 1
// ("assign anyway?"). An assistant's clash is only a warning. Like the fleet guard it never stops anything else: a save that puts nobody
// new on passes untouched (a reschedule alone is never blocked), a booking from before go-live passes, and any failure here lets the save
// through. ARTIST_ASSIGNMENT_GUARD=off switches it off on the server.

const idOf = (v) => (v == null ? '' : String(v._id ?? v));
const PICK = 'bookingNumber customerName status selectedDates bookingDate serviceStart serviceEnd eventSlot service pincode address district region districtId mapUrl dateMaps bookingItems assignedStaff statusHistory';

const scheduleOf = (body) => {
  const out = {};
  if (Array.isArray(body.selectedDates)) out.selectedDates = body.selectedDates.map(String);
  for (const key of ['serviceStart', 'serviceEnd', 'bookingDate']) if (body[key] != null && !Number.isNaN(new Date(body[key]).getTime())) out[key] = new Date(body[key]);
  for (const key of ['pincode', 'address', 'mapUrl', 'eventSlot']) if (typeof body[key] === 'string') out[key] = body[key];
  if (body.districtId !== undefined) out.districtId = body.districtId;
  if (Array.isArray(body.bookingItems)) out.bookingItems = body.bookingItems;
  if (Array.isArray(body.assignedStaff)) out.assignedStaff = body.assignedStaff;
  return out;
};

export const artistAssignmentGuard = async (req, res, next) => {
  try {
    const body = req.body ?? {};
    if (!Array.isArray(body.assignedStaff) && !Array.isArray(body.bookingItems)) return next();
    if (String(req.get('x-confirm-artist-conflict') ?? '') === '1') return next();
    const settings = await getAllocationSettings();
    if (!guardOn(settings)) return next();
    const stored = req.params?.id ? await Booking.findById(req.params.id).select(PICK).lean() : null;
    if (req.params?.id && !stored) return next(); // the controller answers 404
    if (stored && !isNewBooking(stored, settings.liveSince)) return next(); // a booking from before go-live keeps its old ways
    const effective = { ...(stored ?? {}), ...scheduleOf(body), _id: stored?._id ?? new mongoose.Types.ObjectId() };
    if (!A.isAllocatable(effective) && !A.isAllocatable({ status: body.status ?? stored?.status })) return next();

    const before = stored ? staffByUnit(stored) : new Map();
    const after = staffByUnit(effective);
    const added = new Map(); // unitKey → [staff newly on it]
    for (const [unitKey, list] of after) {
      const had = new Set((before.get(unitKey) ?? []).map((s) => idOf(s.employeeId)));
      const fresh = list.filter((s) => s.roleType !== 'driver' && !had.has(idOf(s.employeeId)));
      if (fresh.length) added.set(unitKey, fresh);
    }
    if (added.size === 0) return next();

    // the booking's own days (no places needed for that), then the busy timeline of those days
    const days = [...new Set(A.workUnits(effective, {}, settings).flatMap((u) => u.days.map((d) => d.day)))];
    const { settings: st, state, teams, ctx } = await loadAllocationState({ days, targets: [effective], hot: true });
    const units = A.workUnits(effective, ctx, st);
    const teamByLead = new Map(teams.map((t) => [t.lead.id, t]));
    const problems = [];
    const warnings = [];
    for (const u of units) {
      const fresh = added.get(u.unitKey);
      if (!fresh) continue;
      for (const person of fresh) {
        const pid = idOf(person.employeeId);
        const name = person.artistName || 'She';
        const team = person.roleType === 'lead' ? teamByLead.get(pid) : null;
        for (const nj of u.days) {
          if (team) {
            const v = A.evaluateTeamDay({ team, unit: u, nj, state, settings: st });
            if (v.tier === 'blocked') problems.push({ unitKey: u.unitKey, label: u.label, person: name, day: nj.day, reason: v.reason });
            else if (v.tier === 'extra') problems.push({ unitKey: u.unitKey, label: u.label, person: name, day: nj.day, reason: `${v.fullReason} on ${A.fmtDay(nj.day)} — this would be an EXTRA slot (needs the Artist Head's OK)` });
            else if (v.tier === 'far') warnings.push({ unitKey: u.unitKey, person: name, reason: v.reason });
            for (const w of v.warnings ?? []) warnings.push({ unitKey: u.unitKey, person: name, reason: w });
            continue;
          }
          // anyone else (an assistant, an associate lead): a clash or leave — blocking for a lead, a warning for an assistant
          const clash = (state.jobs.get(pid)?.get(nj.day) ?? []).find((j) => j.bookingId !== idOf(effective._id) && j.startMin < nj.endMin && nj.startMin < j.endMin);
          const leave = (state.leaves.get(pid) ?? []).find((l) => l.fromDay <= nj.day && nj.day <= l.toDay);
          const reason = clash ? `${name} is already on #${clash.bookingNumber || '—'} ${A.fmtTime(clash.start)}–${A.fmtTime(clash.end)} on ${A.fmtDay(nj.day)}` : leave ? `${name} is on leave on ${A.fmtDay(nj.day)}` : '';
          if (!reason) continue;
          (person.roleType === 'lead' ? problems : warnings).push({ unitKey: u.unitKey, label: u.label, person: name, day: nj.day, reason });
        }
      }
    }
    if (problems.length === 0) return next();
    return res.status(409).json({ code: 'ARTIST_CONFLICT', message: `${problems.map((p) => p.reason).join('. ')}. Confirm to assign anyway.`, problems, warnings });
  } catch (err) {
    console.error('artist assignment guard failed (request let through):', err.message);
    return next();
  }
};
