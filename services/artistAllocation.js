import mongoose from 'mongoose';
import ArtistAllocation from '../models/ArtistAllocation.js';
import Booking from '../models/Booking.js';
import District from '../models/District.js';
import Employee from '../models/Employee.js';
import GeoCache from '../models/GeoCache.js';
import Pincode from '../models/Pincode.js';
import { leavesOf } from './fleetAvailability.js';
import { slotAvailability } from '../controllers/slotController.js';
import { loadTeams } from './artistTeams.js';
import { autoOn, getAllocationSettings, isNewBooking, modeOf, moveRotation } from './allocationSettings.js';
import * as A from '../utils/artistAllocation.js';
import { leadOf, staffByUnit, summarizeAssignedStaff, withTeamStaff } from '../utils/bookingStaff.js';
import { mayAllocate, mayApproveExtra } from '../utils/allocationAccess.js';
import { cachedCoordsForPincodes, coordsForPincodes } from '../utils/geocode.js';
import { addDays, istEnd, istStart, istWeekStart } from '../utils/istDate.js';
import { isValidPincode, matchDistrict, normalizePincode } from '../utils/pincodeLookup.js';
import { getUserIdsByEmployeeIds, getUserIdsByRoles, notify, NOTIFICATION_TYPES } from '../utils/notify.js';

// SMART BOOKING ALLOCATION — the database half (the rules: utils/artistAllocation.js).
//
// For a NEW booking (made or confirmed after the allocation went live) the coordinator gets the teams ranked — the same artist when the
// new venue is on her route (time + 30 minutes), else the next free one in the rotation — and confirms one. The booking's staff stays
// the truth of who works it; ArtistAllocation rows hold the slots (M1, M2, E1, or an EXTRA that waits for the Artist Head) and the
// story (suggested vs chosen). No transactions: unique indexes are the locks, a failed step is undone by hand, and every booking save
// re-aligns the rows with the staff (syncAllocationsForBooking).

const idOf = (v) => (v == null ? '' : String(v._id ?? v));
const BOOKING_FIELDS =
  'bookingNumber customerName status selectedDates bookingDate serviceStart serviceEnd eventSlot service pincode address district region districtId mapUrl dateMaps bookingItems assignedStaff statusHistory salesPersonId updatedAt createdAt';

// tests only: runs just before the team is written on the booking (to change the booking at that moment — a race made exact)
let beforeStaffWrite = null;
export const _setBeforeStaffWrite = (fn) => {
  beforeStaffWrite = fn ?? null;
};

export class AllocationRefusal extends Error {
  constructor(message, { status = 409, code = '', extra = {} } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

// ── the context: places of the bookings involved ──────────────────────────────

/** Coordinates and district names for [bookings]' pincodes and districts. [hot] — cache only (never queue a lookup). */
const contextFor = async (bookings, { hot = false } = {}) => {
  const pins = [...new Set(bookings.map(A.pinOf).filter(Boolean))];
  const coords = hot ? await cachedCoordsForPincodes(pins) : (await coordsForPincodes(pins)).coords;
  const pinRows = pins.length ? await Pincode.find({ code: { $in: pins } }).select('code district').lean() : [];
  const districtOfPin = new Map(pinRows.filter((p) => p.district).map((p) => [String(p.code), idOf(p.district)]));
  // a pincode not in our list: the district the place lookup filed it under (cached when the pincode field looked it up), matched to ours
  const unlisted = pins.filter((p) => !districtOfPin.has(p));
  if (unlisted.length) {
    const geo = (await GeoCache.find({ key: { $in: unlisted.map((p) => `pin:${p}`) }, status: 'ok' }).select('key district').lean()).filter((r) => r.district);
    if (geo.length) {
      const ours = await District.find({ status: { $ne: 'inactive' } }).select('name').lean();
      for (const r of geo) {
        const d = matchDistrict(r.district, ours);
        if (d) districtOfPin.set(r.key.slice('pin:'.length), idOf(d));
      }
    }
  }
  const districtIds = [
    ...new Set([...bookings.flatMap((b) => [idOf(b.districtId), ...(b.bookingItems ?? []).map((i) => idOf(i.districtId))]), ...districtOfPin.values()].filter((x) => mongoose.isValidObjectId(x))),
  ];
  const dists = districtIds.length ? await District.find({ _id: { $in: districtIds } }).select('name').lean() : [];
  const names = new Map(dists.map((d) => [idOf(d), d.name]));
  return { coordsOfPin: (p) => coords.get(p) ?? null, districtOfPin: (p) => districtOfPin.get(String(p)) ?? '', districtName: (id) => names.get(idOf(id)) ?? '' };
};

const daysOfUnits = (units) => [...new Set(units.flatMap((u) => u.days.map((d) => d.day)))].sort();

/** Bookings that run on any of [days] (except [excludeIds]) and are happening. */
const bookingsOn = async (days, excludeIds = []) => {
  if (!days.length) return [];
  const query = {
    $or: [{ selectedDates: { $in: days } }, { 'bookingItems.selectedDates': { $in: days } }, { serviceStart: { $gte: istStart(days[0]), $lte: istEnd(days[days.length - 1]) } }],
  };
  const ex = excludeIds.filter((x) => mongoose.isValidObjectId(x));
  if (ex.length) query._id = { $nin: ex };
  return (await Booking.find(query).select(BOOKING_FIELDS).lean()).filter(A.isAllocatable);
};

/**
 * Everything the allocator needs for [days]: { settings, teams, state, ctx, bookings, rows }. [targets] — the bookings being allocated
 * (their places join the context; they are NOT in the busy timeline). A pending EXTRA (staff not written yet) still counts as busy.
 */
export const loadAllocationState = async ({ days, targets = [], hot = false }) => {
  const settings = await getAllocationSettings();
  const teams = await loadTeams();
  const sorted = [...new Set(days)].sort();
  const others = await bookingsOn(sorted, targets.map((t) => idOf(t._id)));
  const rows = sorted.length ? await ArtistAllocation.find({ kind: 'allocation', active: true, day: { $in: sorted } }).lean() : [];
  const ctx = await contextFor([...others, ...targets], { hot });
  const pending = new Map(rows.filter((r) => r.approval?.status === 'pending').map((r) => [`${idOf(r.bookingId)}|${r.unitKey}`, r]));
  const otherUnits = others.flatMap((b) =>
    A.workUnits(b, ctx, settings).map((u) => {
      const p = pending.get(`${u.bookingId}|${u.unitKey}`);
      if (!p || leadOf(u.staff)) return u;
      // an EXTRA waiting for the Artist Head: her time is held already
      return { ...u, staff: [{ employeeId: idOf(p.leadEmployeeId), roleType: 'lead' }, ...(p.assistantEmployeeIds ?? []).map((a) => ({ employeeId: idOf(a), roleType: 'assistant' }))] };
    }),
  );
  const people = [...new Set(teams.flatMap((t) => [t.lead.id, ...t.assistants.map((a) => a.id)]))];
  const leaves = await leavesOf(people, sorted);
  const extrasUsed = new Map();
  for (const r of rows) if (r.extra && r.holdsSlot) extrasUsed.set(r.day, (extrasUsed.get(r.day) ?? 0) + 1);
  const state = A.buildState({ teams, otherUnits, leaves, extrasUsed, lastStartedTeamId: idOf(settings.rotation?.lastStartedTeamId) || null });
  return { settings, teams, state, ctx, bookings: others, rows };
};

// ── suggestions ──────────────────────────────────────────────────────────────

/** The window that counts as "new" for the current mode: suggest → liveSince; shadow → shadowSince. */
const sinceFor = (settings) => {
  const mode = modeOf(settings);
  return mode === 'suggest' ? settings.liveSince : mode === 'shadow' ? settings.shadowSince : null;
};

const unitView = (u) => ({
  unitKey: u.unitKey,
  label: u.label,
  days: u.days.map((d) => ({ day: d.day, start: d.start, end: d.end, half: d.half, timeSet: d.timeSet, place: { label: d.place.label, precision: d.place.precision, districtId: d.place.districtId } })),
});

/** The teams ranked for each package of [bookingId] — and who has it now. */
export const suggestForBooking = async (bookingId, user) => {
  if (!mongoose.isValidObjectId(bookingId)) throw new AllocationRefusal('That booking was not found.', { status: 404 });
  const booking = await Booking.findById(bookingId).select(BOOKING_FIELDS).lean();
  if (!booking) throw new AllocationRefusal('That booking was not found.', { status: 404 });
  const settings0 = await getAllocationSettings();
  const mode = modeOf(settings0);
  const eligible = A.isAllocatable(booking) && isNewBooking(booking, sinceFor(settings0));
  const base = { mode, eligible, bookingId: idOf(booking), bookingNumber: booking.bookingNumber ?? '', customerName: booking.customerName ?? '', status: booking.status, updatedAt: booking.updatedAt };
  if (mode === 'off' || !eligible) {
    return { ...base, canConfirm: false, units: [], message: mode === 'off' ? 'The allocation is switched off.' : 'This booking was made before the allocation went live — its artists are assigned as before.' };
  }
  const ctx0 = await contextFor([booking]);
  const units = A.workUnits(booking, ctx0, settings0);
  const { settings, state, teams, rows } = await loadAllocationState({ days: daysOfUnits(units), targets: [booking] });
  // (the booking's own rows: loadAllocationState reads every active row of those days)
  const teamByLead = new Map(teams.map((t) => [t.lead.id, t]));
  const mine = rows.filter((r) => idOf(r.bookingId) === idOf(booking._id));
  return {
    ...base,
    canConfirm: mode === 'suggest' && mayAllocate(user),
    canApproveExtra: mayApproveExtra(user),
    units: units.map((u) => {
      const lead = leadOf(u.staff);
      const team = lead ? teamByLead.get(idOf(lead.employeeId)) : null;
      const row = mine.find((r) => r.unitKey === u.unitKey);
      return {
        ...unitView(u),
        current: lead ? { leadId: idOf(lead.employeeId), leadName: lead.artistName ?? '', teamId: team?.id ?? null, teamName: team?.name ?? null } : null,
        allocation: row ? { id: idOf(row), teamId: idOf(row.teamId), slotKey: row.slotKey, extra: row.extra, approval: row.approval?.status ?? 'not_needed' } : null,
        candidates: A.rankCandidates({ unit: u, state, settings }),
      };
    }),
  };
};

// ── slot keys ────────────────────────────────────────────────────────────────

/**
 * The slot key a team takes on [day] in [half]: the lowest of M1..Mn / E1..En not held by a row, counted within the room left after
 * her works that have no row (assigned before go-live, or by hand before the allocation) — so the last slot can only be taken once.
 */
const freeSlotKey = ({ team, day, half, rows, state, bookingId }) => {
  const prefix = half === 'morning' ? 'M' : 'E';
  const capacity = Number(team.slots?.[half] ?? (half === 'morning' ? 2 : 1));
  const held = rows.filter((r) => idOf(r.teamId) === team.id && r.day === day && r.holdsSlot && !r.extra && r.slotKey.startsWith(prefix));
  const heldBookings = new Set(held.map((r) => idOf(r.bookingId)));
  const jobs = (state.jobs.get(team.lead.id)?.get(day) ?? []).filter((j) => j.holdsSlot && j.half === half && j.bookingId !== bookingId);
  const untracked = jobs.filter((j) => !heldBookings.has(j.bookingId)).length;
  const room = capacity - untracked;
  const taken = new Set(held.map((r) => r.slotKey));
  for (let i = 1; i <= room; i += 1) if (!taken.has(`${prefix}${i}`)) return `${prefix}${i}`;
  return '';
};
const freeExtra = ({ team, day, rows, settings }) => {
  const extras = rows.filter((r) => r.extra && r.holdsSlot && r.day === day);
  let extraNo = 0;
  for (let i = 1; i <= settings.extrasPerDay; i += 1) {
    if (!extras.some((r) => r.extraNo === i)) {
      extraNo = i;
      break;
    }
  }
  const teamX = extras.filter((r) => idOf(r.teamId) === team.id).length;
  return { extraNo, slotKey: `X${teamX + 1}` };
};

const dupKind = (e) => {
  const msg = String(e?.message ?? '');
  if (e?.code !== 11000) return '';
  if (/extraNo/.test(msg)) return 'EXTRA_TAKEN';
  if (/slotKey/.test(msg)) return 'SLOT_TAKEN';
  return 'ALREADY_ALLOCATED';
};

// ── writing the team on the booking ─────────────────────────────────────────

const associateIdsOf = async (staffLists) => {
  const ids = [...new Set(staffLists.flat().map((s) => idOf(s.employeeId)).filter((x) => mongoose.isValidObjectId(x)))];
  if (!ids.length) return [];
  return (await Employee.find({ _id: { $in: ids }, isAssociate: true }).select('_id').lean()).map(idOf);
};

/** The booking's staff with [byUnit] (unitKey → { lead, assistants }) put on — { $set } for an atomic update. */
const staffSetFor = async (booking, byUnit) => {
  const items = Array.isArray(booking.bookingItems) ? booking.bookingItems : [];
  const assoc = await associateIdsOf([booking.assignedStaff ?? [], ...items.map((i) => i.assignedStaff ?? [])]);
  const set = {};
  if (items.length === 0) {
    const t = byUnit.get('b');
    if (t) set.assignedStaff = withTeamStaff(booking.assignedStaff ?? [], t, { associateIds: assoc });
    return set;
  }
  const newItems = items.map((it, i) => {
    const t = byUnit.get(`i:${i}`);
    if (!t) return it;
    // a package with no team of its own used the booking's: its drivers / associates come with it
    const existing = (it.assignedStaff ?? []).length ? it.assignedStaff : booking.assignedStaff ?? [];
    return { ...it, assignedStaff: withTeamStaff(existing, t, { associateIds: assoc }) };
  });
  for (const [i] of items.entries()) if (byUnit.has(`i:${i}`)) set[`bookingItems.${i}.assignedStaff`] = newItems[i].assignedStaff;
  set.assignedStaff = summarizeAssignedStaff(newItems, booking.assignedStaff ?? []);
  return set;
};

const peopleOf = (staff) => new Set((staff ?? []).filter((s) => s.roleType !== 'driver').map((s) => idOf(s.employeeId)).filter(Boolean));

/** Tell the people put on (or taken off) a booking — one notification per person, all days listed. */
const tellArtists = async ({ booking, before, after, actor, teamName }) => {
  try {
    const days = [...new Set([...(booking.selectedDates ?? []), ...(booking.bookingItems ?? []).flatMap((i) => i.selectedDates ?? [])])].sort().map(A.fmtDay).join(', ');
    const added = [...after].filter((x) => !before.has(x));
    const removed = [...before].filter((x) => !after.has(x));
    const brief = `#${booking.bookingNumber ?? ''} ${booking.customerName ?? ''}`.trim();
    if (added.length) {
      await notify({ recipients: await getUserIdsByEmployeeIds(added), type: NOTIFICATION_TYPES.ARTIST_ASSIGNED, title: 'A new work for you', body: `${brief} · ${days}${teamName ? ` — ${teamName}` : ''}. Open My Works for the time and place.`, bookingId: booking._id, link: '/works', excludeUserId: actor?._id });
    }
    if (removed.length) {
      await notify({ recipients: await getUserIdsByEmployeeIds(removed), type: NOTIFICATION_TYPES.ARTIST_UNASSIGNED, title: 'A work was moved', body: `You are no longer on ${brief} (${days}).`, bookingId: booking._id, link: '/works', excludeUserId: actor?._id });
    }
  } catch (e) {
    console.error('[allocation] artist notification failed:', e?.message ?? e);
  }
};

const tellArtistHeads = async ({ booking, team, day, actor }) => {
  try {
    const ids = await getUserIdsByRoles(['artist_head']);
    await notify({ recipients: ids, type: NOTIFICATION_TYPES.EXTRA_SLOT_REQUEST, title: 'An extra slot to OK', body: `${actor?.name ?? 'A coordinator'} asks for an EXTRA slot for ${team.name} on ${A.fmtDay(day)} (#${booking.bookingNumber ?? ''} ${booking.customerName ?? ''}). Allocation Board → Approve.`, bookingId: booking._id, link: `/booking/allocation?date=${day}`, excludeUserId: actor?._id });
  } catch (e) {
    console.error('[allocation] extra request notification failed:', e?.message ?? e);
  }
};

/** The salesperson credited with the booking learns which team got it (not when they did it themselves — they saw it on screen). */
const tellSalesperson = async ({ booking, teamName, actor, auto = false }) => {
  try {
    const sp = idOf(booking?.salesPersonId);
    if (!sp || !teamName || sp === idOf(actor?._id)) return;
    const days = [...new Set([...(booking.selectedDates ?? []), ...(booking.bookingItems ?? []).flatMap((i) => i.selectedDates ?? [])])].sort().map(A.fmtDay).join(', ');
    await notify({ recipients: [sp], type: NOTIFICATION_TYPES.BOOKING_ARTIST_ASSIGNED, title: 'Artist assigned to your booking', body: `#${booking.bookingNumber ?? ''} ${booking.customerName ?? ''}${days ? ` (${days})` : ''} — ${teamName}${auto ? ', assigned automatically' : ''}.`, bookingId: booking._id, link: `/booking/manage/${idOf(booking._id)}`, excludeUserId: actor?._id });
  } catch (e) {
    console.error('[allocation] salesperson notification failed:', e?.message ?? e);
  }
};

/** CRM learns of a new work the ERP could not give on its own — one notification per booking, with the reasons. */
const tellCrmToAllocate = async ({ booking, waiting, actor }) => {
  try {
    if (!waiting.length) return;
    const ids = await getUserIdsByRoles(['crm', 'crm_manager']);
    const day = waiting[0].unit.days[0]?.day ?? '';
    const why = [...new Set(waiting.map((w) => w.reason))].join(' · ');
    await notify({ recipients: ids, type: NOTIFICATION_TYPES.ALLOCATION_NEEDED, title: 'A new work needs an artist', body: `#${booking.bookingNumber ?? ''} ${booking.customerName ?? ''}${day ? ` (${A.fmtDay(day)})` : ''}: ${why}. Allocation Board → Allocate.`, bookingId: booking._id, link: day ? `/booking/allocation?date=${day}` : '/booking/allocation', excludeUserId: actor?._id });
  } catch (e) {
    console.error('[allocation] CRM notification failed:', e?.message ?? e);
  }
};

// ── confirm (the coordinator's yes) — authoritative, never fails open ─────────

/**
 * Gives packages of a booking to teams. [picks]: [{ unitKey, teamId, assistantIds?, overrideReason? }]. Re-ranks on the server;
 * blocking problems need [confirmConflicts]; an EXTRA from someone who can't approve waits (staff not written) for the Artist Head.
 * → { results: [{ unitKey, teamId, teamName, tier, slotKeys, extra, approval }], updatedAt }
 */
export const confirmAllocation = async ({ user, bookingId, bookingUpdatedAt = null, picks = [], source = 'requests', confirmConflicts = false, auto = false }) => {
  const settings0 = await getAllocationSettings();
  if (modeOf(settings0) !== 'suggest') throw new AllocationRefusal('The allocation is not switched on — assign the artists on Manage Booking.', { code: 'ALLOCATION_OFF' });
  if (auto && !autoOn(settings0)) throw new AllocationRefusal('Automatic allocation is switched off.', { code: 'AUTO_OFF' });
  // [auto]: the ERP's own pick (autoAllocateBooking) — on behalf of whoever confirmed the booking, so no allocate permission is asked
  if (!auto && !mayAllocate(user)) throw new AllocationRefusal('Only the CRM team, the Artist Head or a manager can allocate artists.', { status: 403 });
  if (!mongoose.isValidObjectId(bookingId)) throw new AllocationRefusal('That booking was not found.', { status: 404 });
  const booking = await Booking.findById(bookingId).select(BOOKING_FIELDS).lean();
  if (!booking) throw new AllocationRefusal('That booking was not found.', { status: 404 });
  if (!A.isAllocatable(booking)) throw new AllocationRefusal(`This booking is ${booking.status} — it takes no artist.`, { code: 'NOT_ALLOCATABLE' });
  if (!isNewBooking(booking, settings0.liveSince)) throw new AllocationRefusal('This booking was made before the allocation went live — assign its artists on Manage Booking.', { code: 'NOT_NEW' });
  if (bookingUpdatedAt && new Date(bookingUpdatedAt).getTime() !== new Date(booking.updatedAt).getTime()) {
    throw new AllocationRefusal('Someone changed this booking a moment ago — the suggestions have been refreshed.', { code: 'BOOKING_CHANGED' });
  }
  if (!Array.isArray(picks) || picks.length === 0) throw new AllocationRefusal('Choose a team.', { status: 400 });

  const ctx0 = await contextFor([booking]);
  const units = A.workUnits(booking, ctx0, settings0);
  const loaded = await loadAllocationState({ days: daysOfUnits(units), targets: [booking] });
  const { settings, teams } = loaded;
  let state = loaded.state;

  // decide each pick against the state so far (two packages of one booking count each other)
  const plans = [];
  const problems = [];
  const warnings = [];
  for (const p of picks) {
    const unit = units.find((u) => u.unitKey === String(p.unitKey ?? ''));
    if (!unit) throw new AllocationRefusal('That package is no longer on the booking — refresh.', { status: 400, code: 'BOOKING_CHANGED' });
    const team = teams.find((t) => t.id === String(p.teamId ?? ''));
    if (!team) throw new AllocationRefusal('That team was not found.', { status: 404 });
    const candidates = A.rankCandidates({ unit, state, settings });
    const cand = candidates.find((c) => c.teamId === team.id);
    if (cand.tier === 'blocked') problems.push({ unitKey: unit.unitKey, label: unit.label, team: team.name, reason: cand.reason });
    for (const w of cand.warnings) warnings.push(`${unit.label}: ${w}`);
    let assistants = team.assistants;
    if (Array.isArray(p.assistantIds)) {
      const ids = [...new Set(p.assistantIds.map(String))].filter((x) => x !== team.lead.id && mongoose.isValidObjectId(x));
      const emps = ids.length ? await Employee.find({ _id: { $in: ids }, status: 'active' }).select('name phone specialization works type').lean() : [];
      if (emps.length !== ids.length) throw new AllocationRefusal('One of the assistants was not found (or is not active).', { status: 400 });
      assistants = emps.map((e) => ({ ...e, _id: idOf(e), id: idOf(e) }));
    }
    const top = candidates.find((c) => c.recommended);
    if (auto) {
      // the ERP gives only a clean match, and only the one it would suggest now
      const ap = A.autoPick({ unit, candidates });
      if (!ap.ok || ap.cand.teamId !== team.id) throw new AllocationRefusal(ap.ok ? 'The best team changed a moment ago' : ap.reason, { code: 'AUTO_NOT_CLEAN' });
    }
    plans.push({ unit, team, cand, assistants, top, overrideReason: String(p.overrideReason ?? '').trim().slice(0, 200) });
    state = A.withAllocation(state, unit, { ...team, assistants }, cand);
  }
  if (problems.length && !confirmConflicts) {
    throw new AllocationRefusal(problems.map((x) => `${x.team}: ${x.reason}`).join(' · '), { code: 'ARTIST_CONFLICT', extra: { problems, warnings } });
  }

  // the rows: release the packages' old ones, take the slots
  const unitKeys = plans.map((p) => p.unit.unitKey);
  const old = await ArtistAllocation.find({ bookingId: booking._id, kind: 'allocation', active: true, unitKey: { $in: unitKeys } }).lean();
  await ArtistAllocation.updateMany({ _id: { $in: old.map((r) => r._id) } }, { $set: { active: false, holdsSlot: false, releasedAt: new Date(), releasedReason: 'reallocated' } });
  const rows = (await ArtistAllocation.find({ kind: 'allocation', active: true, day: { $in: daysOfUnits(units) } }).lean());
  const inserted = [];
  const undo = async () => {
    if (inserted.length) await ArtistAllocation.deleteMany({ _id: { $in: inserted } });
    for (const r of old) await ArtistAllocation.updateOne({ _id: r._id }, { $set: { active: true, holdsSlot: r.holdsSlot, releasedAt: null, releasedReason: '' } }).catch(() => {});
  };
  const results = [];
  try {
    for (const plan of plans) {
      const { unit, team, cand, assistants, top } = plan;
      const extra = cand.tier === 'extra';
      const pending = extra && !mayApproveExtra(user);
      const decision = auto ? 'auto' : top && top.teamId === team.id ? 'accepted' : 'override';
      const slotKeys = [];
      for (const [i, nj] of unit.days.entries()) {
        const needsSlot = cand.slots[i]?.needsSlot !== false;
        let slotKey = '';
        let extraNo = null;
        let isExtra = false;
        if (needsSlot) {
          if (extra && cand.extra?.day === nj.day) {
            const fx = freeExtra({ team, day: nj.day, rows: [...rows, ...(await ArtistAllocation.find({ _id: { $in: inserted } }).lean())], settings });
            if (!fx.extraNo) throw new AllocationRefusal(`Both extra slots for ${A.fmtDay(nj.day)} were just taken — choose again.`, { code: 'EXTRA_TAKEN' });
            ({ slotKey, extraNo } = fx);
            isExtra = true;
          } else {
            slotKey = freeSlotKey({ team, day: nj.day, half: nj.half, rows: [...rows, ...(await ArtistAllocation.find({ _id: { $in: inserted } }).lean())], state: loaded.state, bookingId: unit.bookingId });
          }
        }
        const row = await ArtistAllocation.create({
          kind: 'allocation',
          bookingId: booking._id,
          bookingNumber: booking.bookingNumber ?? '',
          customerName: booking.customerName ?? '',
          unitKey: unit.unitKey,
          fingerprint: `${unit.label}|${unit.days.map((d) => d.day).join(',')}|${unit.days[0]?.start ?? ''}`,
          day: nj.day,
          start: nj.start,
          end: nj.end,
          half: nj.half,
          teamId: team.id,
          leadEmployeeId: team.lead.id,
          assistantEmployeeIds: assistants.map((a) => idOf(a._id ?? a.id)),
          active: true,
          holdsSlot: !!slotKey,
          slotKey,
          extra: isExtra,
          extraNo,
          overPlan: needsSlot && !slotKey && !isExtra,
          approval: { status: isExtra ? (pending ? 'pending' : 'approved') : 'not_needed', by: isExtra && !pending ? user?._id ?? null : null, byName: isExtra && !pending ? user?.name ?? '' : '', at: isExtra && !pending ? new Date() : null },
          decision,
          suggestion: { topTeamId: top?.teamId ?? null, chosenRank: cand.rank, tier: cand.tier, reason: cand.reason },
          overrideReason: decision === 'override' ? plan.overrideReason : '',
          conflictsConfirmed: cand.tier === 'blocked' ? [cand.reason] : [],
          source,
          decidedBy: user?._id ?? null,
          decidedByName: auto ? `Automatic${user?.name ? ` (confirmed by ${user.name})` : ''}` : user?.name ?? '',
          decidedAt: new Date(),
        });
        inserted.push(row._id);
        slotKeys.push(slotKey || (needsSlot ? 'over plan' : 'with this booking'));
      }
      results.push({ unitKey: unit.unitKey, teamId: team.id, teamName: team.name, tier: cand.tier, slotKeys, extra, approval: extra ? (pending ? 'pending' : 'approved') : 'not_needed', pending });
    }
  } catch (e) {
    await undo();
    if (e instanceof AllocationRefusal) throw e;
    const kind = dupKind(e);
    if (kind) throw new AllocationRefusal(kind === 'EXTRA_TAKEN' ? 'That extra slot was just taken — choose again.' : kind === 'SLOT_TAKEN' ? 'That slot was just taken by another booking — the suggestions have been refreshed.' : 'Someone else just allocated this booking — refresh.', { code: kind });
    throw e;
  }

  // the staff — written at once, only if nobody changed the booking meanwhile; an EXTRA waiting for the Artist Head is not written yet
  const byUnit = new Map(results.filter((r) => !r.pending).map((r) => {
    const plan = plans.find((p) => p.unit.unitKey === r.unitKey);
    return [r.unitKey, { lead: plan.team.lead, assistants: plan.assistants }];
  }));
  let updatedAt = booking.updatedAt;
  if (byUnit.size) {
    const set = await staffSetFor(booking, byUnit);
    if (beforeStaffWrite) await beforeStaffWrite(booking);
    const res = await Booking.updateOne({ _id: booking._id, updatedAt: booking.updatedAt }, { $set: set });
    if (!res.matchedCount) {
      await undo();
      throw new AllocationRefusal('Someone changed this booking a moment ago — the suggestions have been refreshed.', { code: 'BOOKING_CHANGED' });
    }
    const after = await Booking.findById(booking._id).select(BOOKING_FIELDS).lean();
    updatedAt = after.updatedAt;
    const teamNames = [...new Set(results.filter((r) => !r.pending).map((r) => r.teamName))].join(', ');
    await tellArtists({ booking: after, before: peopleOf(booking.assignedStaff), after: peopleOf(after.assignedStaff), actor: user, teamName: teamNames });
    await tellSalesperson({ booking: after, teamName: teamNames, actor: user, auto });
  }
  for (const r of results.filter((x) => x.pending)) {
    const plan = plans.find((p) => p.unit.unitKey === r.unitKey);
    await tellArtistHeads({ booking, team: plan.team, day: plan.cand.extra?.day ?? plan.unit.days[0]?.day, actor: user });
  }
  const started = [...plans].reverse().find((p) => p.cand.tier === 'new_route');
  if (started) await moveRotation(started.team.id);
  return { results, updatedAt };
};

/** Several bookings, one after another (each counting the ones before). → [{ bookingId, ok, results | message, code }] */
export const confirmMany = async ({ user, items = [], source = 'bulk' }) => {
  const out = [];
  for (const it of items) {
    try {
      const r = await confirmAllocation({ user, bookingId: it.bookingId, picks: it.picks, source, confirmConflicts: !!it.confirmConflicts });
      out.push({ bookingId: String(it.bookingId), ok: true, ...r });
    } catch (e) {
      if (!(e instanceof AllocationRefusal)) throw e;
      out.push({ bookingId: String(it.bookingId), ok: false, message: e.message, code: e.code, ...e.extra });
    }
  }
  return out;
};

/** The Artist Head's yes / no to an EXTRA slot. A yes writes the team on the booking and tells the artists. */
export const decideExtra = async ({ allocationId, approve, user, note = '' }) => {
  if (!mayApproveExtra(user)) throw new AllocationRefusal('Only the Artist Head (or a manager) can OK an extra slot.', { status: 403 });
  if (!mongoose.isValidObjectId(allocationId)) throw new AllocationRefusal('That request was not found.', { status: 404 });
  const row = await ArtistAllocation.findOne({ _id: allocationId, active: true, extra: true, 'approval.status': 'pending' }).lean();
  if (!row) throw new AllocationRefusal('That request was already decided (or withdrawn).', { status: 404 });
  const booking = await Booking.findById(row.bookingId).select(BOOKING_FIELDS).lean();
  const stamp = { 'approval.by': user._id, 'approval.byName': user.name ?? '', 'approval.at': new Date(), 'approval.note': String(note ?? '').slice(0, 200) };
  if (!approve || !booking || !A.isAllocatable(booking)) {
    await ArtistAllocation.updateMany({ bookingId: row.bookingId, unitKey: row.unitKey, active: true, kind: 'allocation' }, { $set: { ...stamp, 'approval.status': 'rejected', active: false, holdsSlot: false, releasedAt: new Date(), releasedReason: 'extra_rejected' } });
    try {
      await notify({ recipients: [row.decidedBy], type: NOTIFICATION_TYPES.EXTRA_SLOT_DECISION, title: 'Extra slot not approved', body: `The extra slot for #${row.bookingNumber} on ${A.fmtDay(row.day)} was not approved${note ? `: ${note}` : ''} — choose another team.`, bookingId: row.bookingId, link: `/booking/allocation?date=${row.day}`, excludeUserId: user._id });
    } catch {
      // the decision stands either way
    }
    return { approved: false };
  }
  const teams = await loadTeams({ includeInactive: true });
  const team = teams.find((t) => t.id === idOf(row.teamId));
  const assistants = (row.assistantEmployeeIds ?? []).length ? await Employee.find({ _id: { $in: row.assistantEmployeeIds } }).select('name phone specialization works type').lean() : [];
  const set = await staffSetFor(booking, new Map([[row.unitKey, { lead: team?.lead ?? { _id: row.leadEmployeeId, name: '' }, assistants: assistants.map((a) => ({ ...a, _id: idOf(a) })) }]]));
  await Booking.updateOne({ _id: booking._id }, { $set: set });
  await ArtistAllocation.updateMany({ bookingId: row.bookingId, unitKey: row.unitKey, active: true, kind: 'allocation' }, { $set: { ...stamp, 'approval.status': 'approved' } });
  const after = await Booking.findById(booking._id).select(BOOKING_FIELDS).lean();
  await tellArtists({ booking: after, before: peopleOf(booking.assignedStaff), after: peopleOf(after.assignedStaff), actor: user, teamName: team?.name });
  await tellSalesperson({ booking: after, teamName: team?.name ?? '', actor: user });
  try {
    await notify({ recipients: [row.decidedBy], type: NOTIFICATION_TYPES.EXTRA_SLOT_DECISION, title: 'Extra slot approved', body: `${team?.name ?? 'The team'} takes #${row.bookingNumber} on ${A.fmtDay(row.day)} as an EXTRA slot.`, bookingId: row.bookingId, link: `/booking/manage/${idOf(row.bookingId)}`, excludeUserId: user._id });
  } catch {
    // approved either way
  }
  return { approved: true };
};

/** Takes a package off its team's slot (and, with [removeStaff], the team off the booking). */
export const releaseUnit = async ({ bookingId, unitKey, user }) => {
  if (!mayAllocate(user)) throw new AllocationRefusal('Only the CRM team, the Artist Head or a manager can change an allocation.', { status: 403 });
  const r = await ArtistAllocation.updateMany({ bookingId, unitKey: String(unitKey), kind: 'allocation', active: true }, { $set: { active: false, holdsSlot: false, releasedAt: new Date(), releasedReason: 'released' } });
  return { released: r.modifiedCount };
};

// ── keeping the rows in step after any booking save ──────────────────────────

/**
 * After a save of a NEW booking (Manage Booking, a status change…), the rows follow the staff: a package whose lead is a team lead holds
 * that team's slot; a changed lead moves the slot; a removed lead or a cancelled booking lets it go. [intent] — what the Manage Booking
 * "Suggest team" chose ({ unitKey, teamId, topTeamId, chosenRank, overrideReason }). Never throws to the caller (safeAllocation).
 */
export const syncAllocationsForBooking = async (booking, { before = null, user = null, intent = null, source = 'manage' } = {}) => {
  const settings = await getAllocationSettings();
  const mode = modeOf(settings);
  if (mode === 'off') return;
  if (mode === 'shadow') return syncShadow(booking, settings);
  if (!isNewBooking(booking, settings.liveSince)) return;
  const rows = await ArtistAllocation.find({ bookingId: booking._id, kind: 'allocation', active: true }).lean();
  const release = (ids, reason) => (ids.length ? ArtistAllocation.updateMany({ _id: { $in: ids } }, { $set: { active: false, holdsSlot: false, releasedAt: new Date(), releasedReason: reason } }) : null);
  if (!A.isAllocatable(booking)) {
    await release(rows.map((r) => r._id), String(booking.status ?? 'cancelled').toLowerCase());
    return;
  }
  const units = A.workUnits(booking, { coordsOfPin: () => null, districtOfPin: () => '', districtName: () => '' }, settings);
  const teams = await loadTeams();
  const teamByLead = new Map(teams.map((t) => [t.lead.id, t]));
  const seen = new Set();
  const placed = new Set(); // teams newly put on (the salesperson hears of them)
  let state = null;
  for (const u of units) {
    const lead = leadOf(u.staff);
    const team = lead ? teamByLead.get(idOf(lead.employeeId)) : null;
    for (const nj of u.days) {
      const row = rows.find((r) => r.unitKey === u.unitKey && r.day === nj.day);
      if (row) seen.add(idOf(row));
      if (row?.approval?.status === 'pending') continue; // an EXTRA waiting for the Artist Head — its staff comes with the yes
      if (!team) {
        if (row) await release([row._id], 'lead_changed');
        continue;
      }
      if (row && idOf(row.teamId) === team.id && row.half === nj.half) {
        if (row.start !== nj.start || row.end !== nj.end) await ArtistAllocation.updateOne({ _id: row._id }, { $set: { start: nj.start, end: nj.end } });
        continue;
      }
      if (row) await release([row._id], idOf(row.teamId) === team.id ? 'rescheduled' : 'lead_changed');
      if (!state) state = (await loadAllocationState({ days: daysOfUnits(units), targets: [booking], hot: true })).state;
      const fresh = await ArtistAllocation.find({ kind: 'allocation', active: true, day: nj.day }).lean();
      let slotKey = freeSlotKey({ team, day: nj.day, half: nj.half, rows: fresh, state, bookingId: idOf(booking._id) });
      let extra = false;
      let extraNo = null;
      if (!slotKey) {
        const fx = freeExtra({ team, day: nj.day, rows: fresh, settings: A.normalizeSettings(settings) });
        if (fx.extraNo) {
          slotKey = fx.slotKey;
          extraNo = fx.extraNo;
          extra = true;
        }
      }
      const fromIntent = intent && String(intent.unitKey) === u.unitKey && String(intent.teamId) === team.id;
      const doc = {
        kind: 'allocation', bookingId: booking._id, bookingNumber: booking.bookingNumber ?? '', customerName: booking.customerName ?? '', unitKey: u.unitKey,
        fingerprint: `${u.label}|${u.days.map((d) => d.day).join(',')}|${u.days[0]?.start ?? ''}`, day: nj.day, start: nj.start, end: nj.end, half: nj.half,
        teamId: team.id, leadEmployeeId: team.lead.id, assistantEmployeeIds: u.staff.filter((s) => s.roleType === 'assistant').map((s) => idOf(s.employeeId)),
        active: true, holdsSlot: !!slotKey, slotKey, extra, extraNo, overPlan: !slotKey,
        // a hand-made assignment past her slots: the extra is OK'd by whoever made it only if they may approve
        approval: { status: extra ? (user && mayApproveExtra(user) ? 'approved' : 'pending') : 'not_needed', byName: extra && user && mayApproveExtra(user) ? user.name ?? '' : '' },
        decision: fromIntent ? (Number(intent.chosenRank) === 1 ? 'accepted' : 'override') : 'manual',
        suggestion: fromIntent ? { topTeamId: mongoose.isValidObjectId(intent.topTeamId) ? intent.topTeamId : null, chosenRank: Number(intent.chosenRank) || null, tier: String(intent.tier ?? ''), reason: '' } : {},
        overrideReason: fromIntent ? String(intent.overrideReason ?? '').slice(0, 200) : '',
        source, decidedBy: user?._id ?? null, decidedByName: user?.name ?? '', decidedAt: new Date(),
      };
      try {
        await ArtistAllocation.create(doc);
      } catch (e) {
        if (e?.code !== 11000) throw e;
        await ArtistAllocation.create({ ...doc, holdsSlot: false, slotKey: '', extra: false, extraNo: null, overPlan: true }).catch(() => {});
      }
      if (doc.approval.status !== 'pending') placed.add(team.name);
      if (extra && doc.approval.status === 'pending') await tellArtistHeads({ booking, team, day: nj.day, actor: user });
    }
  }
  const gone = rows.filter((r) => !seen.has(idOf(r))).map((r) => r._id);
  await release(gone, 'package_removed');
  if (placed.size && source !== 'create') await tellSalesperson({ booking, teamName: [...placed].join(', '), actor: user });
  if (before) {
    const after = new Set([...staffByUnit(booking).values()].flatMap((list) => [...peopleOf(list)]));
    const prev = new Set([...before.values()].flatMap((list) => [...peopleOf(list)]));
    await tellArtists({ booking, before: prev, after, actor: user });
  }
};

// ── automatic allocation: the ERP gives clean matches on its own ────────────

const unitBrief = (u) => ({ unitKey: u.unitKey, label: u.label, days: u.days.map((d) => ({ day: d.day, start: d.start, half: d.half, place: d.place.label })) });

/**
 * AUTOMATIC ALLOCATION (settings autoAllocate on, mode suggest): right after a NEW booking is confirmed — made by staff (sales included),
 * or a request accepted — each package with no main artist yet goes to the top team when the match is clean (A.autoPick: the same area as
 * her other job, or a free artist who prefers that place). The rest wait on the Allocation Board and CRM is told why. The write goes
 * through confirmAllocation (slots, staff, the artists' notifications); a slot taken a moment ago means one fresh try.
 * → null (off / not a new confirmed booking) | { auto: true, units: [{ unitKey, label, days, status: 'assigned' | 'waiting' | 'had_artist', teamName, reason }] }
 */
export const autoAllocateBooking = async (bookingIn, { user = null, source = 'auto' } = {}) => {
  const settings0 = await getAllocationSettings();
  if (!autoOn(settings0) || !bookingIn?._id) return null;
  const id = bookingIn._id;
  const first = await Booking.findById(id).select(BOOKING_FIELDS).lean();
  if (!first || String(first.status ?? '').toLowerCase() !== 'confirmed' || !isNewBooking(first, settings0.liveSince)) return null;

  const decide = async () => {
    const booking = await Booking.findById(id).select(BOOKING_FIELDS).lean();
    const days = daysOfUnits(A.workUnits(booking, {}, settings0));
    const loaded = await loadAllocationState({ days, targets: [booking] });
    const units = A.workUnits(booking, loaded.ctx, loaded.settings).filter((u) => u.days.length);
    let state = loaded.state;
    const picks = [];
    const waiting = [];
    const open = units.filter((u) => !leadOf(u.staff)).sort((x, y) => `${x.days[0].day}${x.days[0].start}`.localeCompare(`${y.days[0].day}${y.days[0].start}`));
    for (const u of open) {
      const candidates = A.rankCandidates({ unit: u, state, settings: loaded.settings });
      const ap = A.autoPick({ unit: u, candidates });
      if (!ap.ok) {
        waiting.push({ unit: u, reason: ap.reason });
        continue;
      }
      picks.push({ unit: u, cand: ap.cand });
      const team = loaded.teams.find((t) => t.id === ap.cand.teamId);
      state = A.withAllocation(state, u, team, ap.cand); // a second package of the booking counts this one
    }
    return { booking, units, picks, waiting };
  };

  let plan = await decide();
  let results = [];
  for (let attempt = 0; plan.picks.length && attempt < 2; attempt += 1) {
    try {
      results = (await confirmAllocation({ user, bookingId: id, bookingUpdatedAt: plan.booking.updatedAt, picks: plan.picks.map((p) => ({ unitKey: p.unit.unitKey, teamId: p.cand.teamId })), source, auto: true })).results;
      break;
    } catch (e) {
      if (!(e instanceof AllocationRefusal)) throw e;
      const retry = attempt === 0 && ['SLOT_TAKEN', 'BOOKING_CHANGED', 'ALREADY_ALLOCATED', 'AUTO_NOT_CLEAN'].includes(e.code);
      if (retry) {
        plan = await decide();
        continue;
      }
      plan.waiting.push(...plan.picks.map((p) => ({ unit: p.unit, reason: `Could not be given automatically — ${e.message}` })));
      plan.picks = [];
    }
  }
  const reasonOf = new Map(plan.picks.map((p) => [p.unit.unitKey, p.cand.reason]));
  const units = plan.units.map((u) => {
    const done = results.find((r) => r.unitKey === u.unitKey);
    if (done) return { ...unitBrief(u), status: 'assigned', teamName: done.teamName, reason: reasonOf.get(u.unitKey) ?? '' };
    const w = plan.waiting.find((x) => x.unit.unitKey === u.unitKey);
    if (w) return { ...unitBrief(u), status: 'waiting', teamName: '', reason: w.reason };
    return { ...unitBrief(u), status: 'had_artist', teamName: '', reason: '' };
  });
  await tellCrmToAllocate({ booking: plan.booking, waiting: plan.waiting, actor: user });
  return { auto: true, units };
};

/**
 * One booking's artist allocation, for anyone who reads it (the salespeople too): per package who has it (and how — automatically, by
 * CRM, by hand) or why it waits. Read-only; nothing is written. → { mode, auto, eligible, status, units: [...] }
 */
export const bookingAllocationStatus = async (bookingId) => {
  if (!mongoose.isValidObjectId(bookingId)) throw new AllocationRefusal('That booking was not found.', { status: 404 });
  const booking = await Booking.findById(bookingId).select(BOOKING_FIELDS).lean();
  if (!booking) throw new AllocationRefusal('That booking was not found.', { status: 404 });
  const settings0 = await getAllocationSettings();
  const mode = modeOf(settings0);
  const auto = autoOn(settings0);
  const status = String(booking.status ?? '').toLowerCase();
  const eligible = mode === 'suggest' && A.isAllocatable(booking) && isNewBooking(booking, settings0.liveSince);
  const rows = await ArtistAllocation.find({ bookingId: booking._id, kind: 'allocation', active: true }).lean();
  const teams = await loadTeams({ includeInactive: true });
  const teamByLead = new Map(teams.map((t) => [t.lead.id, t]));
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const days = daysOfUnits(A.workUnits(booking, {}, settings0));
  let loaded = null;
  const units = A.workUnits(booking, {}, settings0).filter((u) => u.days.length);
  const out = [];
  for (const u of units) {
    const lead = leadOf(u.staff);
    const mine = rows.filter((r) => r.unitKey === u.unitKey);
    const base = unitBrief(u);
    if (lead) {
      const team = teamByLead.get(idOf(lead.employeeId));
      const row = mine.find((r) => idOf(r.leadEmployeeId) === idOf(lead.employeeId)) ?? null;
      const how = row?.decision === 'auto' ? 'auto' : row && row.decision !== 'manual' ? 'crm' : 'by_hand';
      out.push({ ...base, status: 'assigned', teamName: team?.name ?? '', lead: lead.artistName ?? '', assistants: u.staff.filter((x) => x.roleType === 'assistant').map((x) => x.artistName ?? '').filter(Boolean), how, by: row?.decidedByName ?? '', reason: row?.suggestion?.reason ?? '' });
      continue;
    }
    const pendingRow = mine.find((r) => r.approval?.status === 'pending');
    if (pendingRow) {
      out.push({ ...base, status: 'waiting_approval', teamName: teamById.get(idOf(pendingRow.teamId))?.name ?? '', lead: '', assistants: [], how: '', by: pendingRow.decidedByName ?? '', reason: "An EXTRA slot — waiting for the Artist Head's OK" });
      continue;
    }
    let reason = '';
    if (status === 'pending') reason = 'The artist is assigned once the booking is confirmed';
    else if (!eligible) reason = mode === 'suggest' ? 'Made before the allocation went live — the artist is assigned on Manage Booking' : 'Not assigned yet';
    else {
      if (!loaded) loaded = await loadAllocationState({ days, targets: [booking], hot: true });
      const unit = A.workUnits(booking, loaded.ctx, loaded.settings).find((x) => x.unitKey === u.unitKey) ?? u;
      const ap = A.autoPick({ unit, candidates: A.rankCandidates({ unit, state: loaded.state, settings: loaded.settings }) });
      reason = ap.ok ? `Waiting for CRM — likely ${ap.cand.teamName} (${ap.cand.reason})` : `Waiting for CRM — ${ap.reason}`;
    }
    out.push({ ...base, status: 'waiting', teamName: '', lead: '', assistants: [], how: '', by: '', reason });
  }
  return { bookingId: idOf(booking), bookingNumber: booking.bookingNumber ?? '', mode, auto, eligible, status, units: out };
};

// ── a FULL date: can a work still go to an artist as her 4th work? ────────────

/** 'YYYY-MM-DD' → the Date the booking save reads it as (so the day limit is counted the same way). */
const dateOnlyLocal = (day) => {
  const [y, m, d] = String(day).split('-').map(Number);
  return new Date(y, m - 1, d);
};

/**
 * When HR's day limit for [booking]'s (first) date is reached: for each of its packages, the team that can take it AT the requested
 * time as a 4th work (the same rules as confirming — both drives and the ready time, within the travel limit, at most one work past her
 * slots), but only where her works that day stay one close route (A.fourthWorkWindows); and the other times it would fit.
 * At most `extrasPerDay` bookings past the day's limit. Nothing is written.
 * → null (allocation off / no date) | { full: false, ... } | { full: true, blocked, day, booked, capacity, left, units: [{ unitKey, label, start,
 *   end, place, timeSet, fit: { teamId, teamName, lead, assistants, tier, reason, needsOk } | null, options: [{ teamName, lead, windows }] }] }
 */
export const fourthWorkCheck = async (booking, { excludeBookingId = null } = {}) => {
  const settings0 = await getAllocationSettings();
  if (modeOf(settings0) !== 'suggest') return null;
  const first = A.workUnits(booking, {}, settings0).find((u) => u.days.length);
  const day = first?.days[0]?.day;
  if (!day) return null;
  const slot = await slotAvailability(dateOnlyLocal(day), '', excludeBookingId);
  if (!slot.full) return { full: false, day, booked: slot.booked ?? 0, capacity: slot.capacity ?? 0, units: [] };
  if (slot.blocked) return { full: true, blocked: true, day, booked: slot.booked ?? 0, capacity: slot.capacity ?? 0, left: 0, units: [] };
  const left = Math.max(0, slot.capacity + A.normalizeSettings(settings0).extrasPerDay - slot.booked);
  const loaded = await loadAllocationState({ days: [day], targets: [booking], hot: true });
  let state = loaded.state;
  const units = A.workUnits(booking, loaded.ctx, loaded.settings)
    .filter((u) => u.days.some((d) => d.day === day))
    .map((u) => ({ ...u, days: u.days.filter((d) => d.day === day) }));
  const out = [];
  for (const u of units) {
    const nj = u.days[0];
    // each team's gaps, nearest the asked time first (the one it falls in, then the closest)
    const off = (x) => (nj.startMin >= x.fromMin && nj.startMin <= x.toMin ? 0 : Math.min(Math.abs(x.fromMin - nj.startMin), Math.abs(x.toMin - nj.startMin)));
    const windows = A.fourthWorkWindows({ nj, state, settings: loaded.settings })
      .map((w) => ({ ...w, windows: [...w.windows].sort((p, q) => off(p) - off(q)) }))
      .sort((p, q) => off(p.windows[0]) - off(q.windows[0]));
    const inWindow = (teamId) => windows.find((w) => w.teamId === teamId)?.windows.some((x) => nj.startMin >= x.fromMin && nj.endMin <= x.toMin) ?? false;
    const candidates = A.rankCandidates({ unit: u, state, settings: loaded.settings });
    // the requested time: a team that takes it by the usual rules AND keeps her day one close route (a free team simply starts one)
    const fit = left > 0 && nj.timeSet ? candidates.find((c) => c.tier === 'new_route' || (['continue', 'extra'].includes(c.tier) && inWindow(c.teamId))) ?? null : null;
    out.push({
      unitKey: u.unitKey, label: u.label, start: nj.start, end: nj.end, half: nj.half, place: nj.place.label, timeSet: nj.timeSet,
      fit: fit ? { teamId: fit.teamId, teamName: fit.teamName, lead: fit.lead?.name ?? '', assistants: fit.assistants.map((x) => x.name), tier: fit.tier, reason: fit.reason, needsOk: fit.tier === 'extra' } : null,
      options: left > 0 ? windows.slice(0, 4).map((w) => ({ teamId: w.teamId, teamName: w.teamName, lead: w.lead, jobs: w.jobs, windows: w.windows.slice(0, 2).map((x) => ({ from: x.from, to: x.to, reason: x.reason })) })) : [],
    });
    if (fit) state = A.withAllocation(state, u, loaded.teams.find((t) => t.id === fit.teamId), fit);
  }
  return { full: true, blocked: false, day, booked: slot.booked, capacity: slot.capacity, left, units: out };
};

/** The words for a full date — what is still possible, or why not (the booking form and the refused save say the same). */
export const dayFullMessage = (check, { canBook = false } = {}) => {
  const base = check?.blocked
    ? 'This date has been blocked by HR — no bookings can be added. Please choose another date.'
    : `That date is fully booked (${check?.booked ?? '?'}/${check?.capacity ?? '?'}).`;
  if (!check || check.blocked) return base;
  const units = check.units ?? [];
  if (check.left <= 0) return `${base} Both works past the day's limit are taken too. Please choose another date.`;
  if (units.length && units.every((u) => u.fit)) {
    const f = units[0].fit;
    const who = `${f.teamName} at ${A.fmtTime(units[0].start)}${f.reason ? ` (${f.reason.replace(/^EXTRA [^—]*— [^;]*; /, '').replace(/\. Needs the Artist Head's OK$/, '')})` : ''}`;
    return canBook ? `${base} A 4th work is possible — ${who}.` : `${base} A 4th work is possible — ${who}. Ask CRM to book it.`;
  }
  const opts = units.flatMap((u) => u.options).slice(0, 3).map((o) => `${o.teamName} ${o.windows.map((w) => `${A.fmtTime(w.from)}–${A.fmtTime(w.to)}`).join(' or ')}`);
  if (opts.length) return `${base} Not at that time — a 4th work fits: ${opts.join('; ')}. ${canBook ? 'Change the time to one of these.' : 'Ask CRM to book it at one of these times.'}`;
  return `${base} No artist has time for another work near ${units[0]?.place || 'that place'} that day. Please choose another date.`;
};

// ── the Add Booking preview: who would take a booking not saved yet ───────────

const draftDay = (v) => {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v ?? ''));
  return m ? m[1] : '';
};
const draftTime = (v) => (/^\d{1,2}:\d{2}$/.test(String(v ?? '').trim()) ? String(v).trim().padStart(5, '0') : '');

/**
 * As the booking form is filled in (not saved): the teams that prefer the venue's area, and — once the event days and times are there —
 * who the ERP would give each package to (A.autoPick, the same rule as on confirm) or why CRM would decide. Nothing is written; no
 * place lookup is made (cached places only). [draft]: { pincode, districtId, mapUrl, selectedDates, bookingItems: [{ service, eventSlot,
 * selectedDates, startTime, endTime, districtId, mapUrl }] }.
 * → { on, mode, auto, area: { pincode, districtName, preferredTeams: [{ teamName, lead, assistants, match }] }, units: [...] }
 */
export const previewAllocation = async (draft = {}, user = null) => {
  const settings0 = await getAllocationSettings();
  const mode = modeOf(settings0);
  const auto = autoOn(settings0);
  if (mode !== 'suggest') return { on: false, mode, auto: false, area: null, units: [] };
  const oid = (v) => (mongoose.isValidObjectId(v) ? String(v) : '');
  const pin = normalizePincode(draft.pincode);
  const pincode = isValidPincode(pin) ? pin : '';
  const items = (Array.isArray(draft.bookingItems) ? draft.bookingItems : []).slice(0, 30).map((i) => ({
    service: String(i?.service ?? '').slice(0, 80),
    eventSlot: String(i?.eventSlot ?? '').slice(0, 80),
    selectedDates: (Array.isArray(i?.selectedDates) ? i.selectedDates : []).map(draftDay).filter(Boolean).slice(0, 10),
    startTime: draftTime(i?.startTime),
    endTime: draftTime(i?.endTime),
    districtId: oid(i?.districtId),
    mapUrl: String(i?.mapUrl ?? '').slice(0, 500),
    assignedStaff: [],
  }));
  const selectedDates = [...new Set([...(Array.isArray(draft.selectedDates) ? draft.selectedDates : []).map(draftDay), ...items.flatMap((i) => i.selectedDates)].filter(Boolean))].sort().slice(0, 10);
  const booking = {
    _id: new mongoose.Types.ObjectId(),
    bookingNumber: '',
    customerName: '',
    status: 'confirmed',
    pincode,
    districtId: oid(draft.districtId),
    mapUrl: String(draft.mapUrl ?? '').slice(0, 500),
    eventSlot: String(draft.eventSlot ?? '').slice(0, 80),
    selectedDates,
    bookingItems: items,
    assignedStaff: [],
  };

  // the area: the teams that prefer it (pincode area first, then district; rotation order)
  const ctx0 = await contextFor([booking], { hot: true });
  const districtId = booking.districtId || items.find((i) => i.districtId)?.districtId || (pincode ? ctx0.districtOfPin(pincode) : '');
  const teams = await loadTeams();
  const preferredTeams = teams
    .map((t) => ({ t, match: pincode && (t.preferredPincodes ?? []).map(String).includes(pincode) ? 'pincode' : districtId && (t.preferredDistrictIds ?? []).map(idOf).includes(districtId) ? 'district' : '' }))
    .filter((x) => x.match)
    .sort((x, y) => (x.match === y.match ? (x.t.rotationOrder ?? 0) - (y.t.rotationOrder ?? 0) : x.match === 'pincode' ? -1 : 1))
    .map(({ t, match }) => ({ teamId: t.id, teamName: t.name, lead: t.lead?.name ?? '', assistants: (t.assistants ?? []).map((a) => a.name ?? ''), match }));
  const area = { pincode, districtId, districtName: districtId ? ctx0.districtName(districtId) : '', preferredTeams, teams: teams.length };

  // the days: who would take each package, the same way as on confirm
  const units = [];
  if (selectedDates.length && teams.length) {
    const days = daysOfUnits(A.workUnits(booking, {}, settings0));
    const loaded = await loadAllocationState({ days, targets: [booking], hot: true });
    let state = loaded.state;
    const list = A.workUnits(booking, loaded.ctx, loaded.settings)
      .filter((u) => u.days.length)
      .sort((x, y) => `${x.days[0].day}${x.days[0].start}`.localeCompare(`${y.days[0].day}${y.days[0].start}`));
    for (const u of list) {
      const candidates = A.rankCandidates({ unit: u, state, settings: loaded.settings });
      const ap = A.autoPick({ unit: u, candidates });
      const top = ap.ok ? ap.cand : candidates.find((c) => c.recommended) ?? null;
      units.push({
        ...unitBrief(u),
        ok: ap.ok,
        reason: ap.ok ? ap.cand.reason : ap.reason,
        top: top && top.tier !== 'blocked' ? { teamName: top.teamName, lead: top.lead?.name ?? '', assistants: (top.assistants ?? []).map((x) => x.name), tier: top.tier, reason: top.reason } : null,
      });
      if (ap.ok) state = A.withAllocation(state, u, loaded.teams.find((t) => t.id === ap.cand.teamId), ap.cand);
    }
  }
  // a FULL date: where a 4th work could still go (Add Booking says so; CRM books it)
  const dayCheck = selectedDates.length && teams.length ? await fourthWorkCheck(booking) : null;
  return { on: true, mode, auto, area, units, day: dayCheck ? { ...dayCheck, canBook: mayAllocate(user), message: dayCheck.full ? dayFullMessage(dayCheck, { canBook: mayAllocate(user) }) : '' } : null };
};

// ── shadow mode: what the ERP would have suggested ───────────────────────────

/** Notes the ERP's pick for each package of a new booking (shadow mode), to compare with what the coordinators choose. */
export const logShadowSuggestion = async (booking) => {
  const settings = await getAllocationSettings();
  if (modeOf(settings) !== 'shadow' || !isNewBooking(booking, settings.shadowSince) || !A.isAllocatable(booking)) return;
  const ctx0 = await contextFor([booking], { hot: true });
  const units = A.workUnits(booking, ctx0, settings);
  const { state } = await loadAllocationState({ days: daysOfUnits(units), targets: [booking], hot: true });
  for (const u of units) {
    const top = A.rankCandidates({ unit: u, state, settings }).find((c) => c.recommended);
    for (const nj of u.days) {
      await ArtistAllocation.findOneAndUpdate(
        { bookingId: booking._id, unitKey: u.unitKey, day: nj.day, kind: 'shadow', active: true },
        { $set: { bookingNumber: booking.bookingNumber ?? '', customerName: booking.customerName ?? '', start: nj.start, end: nj.end, half: nj.half, 'shadow.suggestedTeamId': top?.teamId ?? null, 'suggestion.tier': top?.tier ?? '', 'suggestion.reason': top?.reason ?? '', decidedAt: new Date() } },
        { upsert: true, setDefaultsOnInsert: true },
      );
    }
  }
  await syncShadow(booking, settings);
};

/** Shadow rows learn which team the coordinators actually put on. */
const syncShadow = async (booking, settings) => {
  if (!isNewBooking(booking, settings.shadowSince)) return;
  const teams = await loadTeams();
  const teamByLead = new Map(teams.map((t) => [t.lead.id, t]));
  for (const [unitKey, staff] of staffByUnit(booking)) {
    const lead = leadOf(staff);
    const team = lead ? teamByLead.get(idOf(lead.employeeId)) : null;
    if (!team) continue;
    const rows = await ArtistAllocation.find({ bookingId: booking._id, unitKey, kind: 'shadow', active: true }).lean();
    for (const r of rows) {
      await ArtistAllocation.updateOne({ _id: r._id }, { $set: { 'shadow.actualTeamId': team.id, 'shadow.matched': idOf(r.shadow?.suggestedTeamId) === team.id } });
    }
  }
};

// ── the Allocation Board ─────────────────────────────────────────────────────

/** The day for the Board: each team's slots and jobs, the new works with no artist yet (with their top suggestion), pending extras. */
export const dayBoard = async (day, user) => {
  const settings0 = await getAllocationSettings();
  const mode = modeOf(settings0);
  const since = sinceFor(settings0);
  const { settings, teams, state, ctx, bookings, rows } = await loadAllocationState({ days: [day] });
  const st = A.normalizeSettings(settings);
  const rowsBy = new Map(rows.map((r) => [`${idOf(r.bookingId)}|${r.unitKey}|${r.day}`, r]));
  const teamLeadIds = new Set(teams.map((t) => t.lead.id));

  const teamCards = teams.map((t) => {
    const jobs = (state.jobs.get(t.lead.id)?.get(day) ?? []).map((j) => {
      const row = rowsBy.get(`${j.bookingId}|${j.unitKey}|${day}`);
      return { bookingId: j.bookingId, bookingNumber: j.bookingNumber, customerName: j.customerName, unitKey: j.unitKey, start: j.start, end: j.end, half: j.half, place: { label: j.place?.label ?? '', districtId: j.place?.districtId ?? '' }, holdsSlot: j.holdsSlot, slotKey: row?.slotKey ?? '', extra: !!row?.extra, approval: row?.approval?.status ?? 'not_needed', overPlan: !!row?.overPlan };
    });
    // the slots: M1.., E1.. (+ any X), each with the job holding it — rows by their key, works without a row fill the rest in time order
    const slots = [];
    for (const half of ['morning', 'evening']) {
      const prefix = half === 'morning' ? 'M' : 'E';
      const cap = Number(t.slots?.[half] ?? 0);
      const own = jobs.filter((j) => j.holdsSlot && j.half === half && !j.extra);
      const keyed = new Map(own.filter((j) => j.slotKey.startsWith(prefix)).map((j) => [j.slotKey, j]));
      const loose = own.filter((j) => !j.slotKey.startsWith(prefix));
      for (let i = 1; i <= Math.max(cap, own.length); i += 1) {
        const key = `${prefix}${i}`;
        const job = keyed.get(key) ?? loose.shift() ?? null;
        slots.push({ key, half, over: i > cap, job: job ? { bookingId: job.bookingId, bookingNumber: job.bookingNumber, customerName: job.customerName ?? '', start: job.start, end: job.end, label: job.place.label } : null });
      }
    }
    for (const j of jobs.filter((x) => x.extra)) slots.push({ key: j.slotKey || 'X', half: j.half, extra: true, approval: j.approval, job: { bookingId: j.bookingId, bookingNumber: j.bookingNumber, customerName: j.customerName ?? '', start: j.start, end: j.end, label: j.place.label } });
    const leave = (state.leaves.get(t.lead.id) ?? []).find((l) => l.fromDay <= day && day <= l.toDay) ?? null;
    const last = jobs.reduce((a, j) => (a && A.toMin(a.end) >= A.toMin(j.end) ? a : j), null); // the one that ends last
    const capTotal = Number(t.slots?.morning ?? 0) + Number(t.slots?.evening ?? 0);
    const used = jobs.filter((j) => j.holdsSlot).length;
    const status = leave && (!leave.halfDay || leave.halfDay === 'none') ? 'on_leave' : leave ? 'half_leave' : used === 0 ? 'free' : used >= capTotal ? 'full' : 'has_room';
    return {
      id: t.id, name: t.name, order: t.rotationOrder, lead: { id: t.lead.id, name: t.lead.name }, assistants: t.assistants.map((a) => ({ id: a.id, name: a.name })),
      slotsPlan: t.slots, status, used, of: capTotal, jobs, slots, leave: leave ? { halfDay: leave.halfDay ?? 'none' } : null,
      freeFrom: last ? last.end : '',
      freeFromText: last ? `free from ${A.fmtTime(last.end)}${last.place.label ? `, after the ${last.place.label} job` : ''}` : 'free all day',
    };
  });

  // the queue: new works on the day whose package has no lead yet (confirmed — a pending request is the CRM's first)
  const queueUnits = [];
  const otherWorks = [];
  for (const b of bookings) {
    if (String(b.status ?? '').toLowerCase() === 'pending') continue;
    for (const u of A.workUnits(b, ctx, settings)) {
      if (!u.days.some((d) => d.day === day)) continue;
      const lead = leadOf(u.staff);
      if (!lead) {
        if (isNewBooking(b, since)) queueUnits.push({ ...u, days: u.days.filter((d) => d.day === day) });
      } else if (!teamLeadIds.has(idOf(lead.employeeId))) {
        otherWorks.push({ bookingId: u.bookingId, bookingNumber: u.bookingNumber, customerName: u.customerName, unitKey: u.unitKey, leadName: lead.artistName ?? '', start: u.days.find((d) => d.day === day)?.start ?? '' });
      }
    }
  }
  const { plan } = A.planUnits({ units: queueUnits, state, settings });
  const nearOf = (nj) =>
    teams
      .map((t) => {
        const jobs = state.jobs.get(t.lead.id)?.get(day) ?? [];
        const best = jobs.map((j) => A.driveBetween(j.place, nj.place)).filter((d) => d.known).sort((a, b) => a.minutes - b.minutes)[0];
        return best ? { teamId: t.id, minutes: best.minutes, km: best.km } : null;
      })
      .filter((x) => x && x.minutes <= 60);
  const queue = plan.map(({ unit, pick }) => {
    const nj = unit.days[0];
    return {
      bookingId: unit.bookingId, bookingNumber: unit.bookingNumber, customerName: unit.customerName, unitKey: unit.unitKey, label: unit.label,
      start: nj.start, end: nj.end, half: nj.half, timeSet: nj.timeSet, place: { label: nj.place.label, districtId: nj.place.districtId, precision: nj.place.precision },
      top: pick ? { teamId: pick.teamId, teamName: pick.teamName, tier: pick.tier, reason: pick.reason } : null,
      nearTeams: nearOf(nj),
      nearWorks: plan.filter((p) => p.unit !== unit).map((p) => ({ bookingId: p.unit.bookingId, unitKey: p.unit.unitKey, ...A.driveBetween(p.unit.days[0].place, nj.place) })).filter((x) => x.known && x.minutes <= 60).map(({ bookingId, unitKey, minutes }) => ({ bookingId, unitKey, minutes })),
    };
  });
  const pendingExtras = rows.filter((r) => r.extra && r.approval?.status === 'pending').map((r) => ({ id: idOf(r), bookingId: idOf(r.bookingId), bookingNumber: r.bookingNumber, customerName: r.customerName, day: r.day, start: r.start, teamId: idOf(r.teamId), teamName: teams.find((t) => t.id === idOf(r.teamId))?.name ?? '', askedBy: r.decidedByName ?? '', reason: r.suggestion?.reason ?? '' }));
  const planned = teams.reduce((n, t) => n + Number(t.slots?.morning ?? 0) + Number(t.slots?.evening ?? 0), 0);
  return {
    day, mode, canAllocate: mode === 'suggest' && mayAllocate(user), canApproveExtra: mayApproveExtra(user),
    settings: { eveningCutoff: st.eveningCutoff, travelLimitMin: st.travelLimitMin, extrasPerDay: st.extrasPerDay },
    summary: { planned, booked: teamCards.reduce((n, t) => n + t.used, 0), extrasUsed: state.extrasUsed.get(day) ?? 0, extrasPending: pendingExtras.length, unallocated: queue.length, outsourced: otherWorks.length },
    teams: teamCards, queue, pendingExtras, otherWorks,
    week: await weekTrend(day, since),
  };
};

/** Monday to Sunday of [day]'s week ('YYYY-MM-DD'). */
export const weekOf = (day) => {
  const monday = istWeekStart(day);
  return [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(monday, i));
};

/** The Board's little week lines: for each day of [day]'s week — slots booked, extras, new works still to allocate, extras waiting. */
const weekTrend = async (day, since) => {
  const days = weekOf(day);
  const { settings, teams, state, ctx, bookings, rows } = await loadAllocationState({ days, hot: true });
  const units = bookings.filter((b) => String(b.status ?? '').toLowerCase() !== 'pending' && isNewBooking(b, since)).flatMap((b) => A.workUnits(b, ctx, settings)).filter((u) => !leadOf(u.staff));
  return days.map((d) => ({
    day: d,
    booked: teams.reduce((n, t) => n + (state.jobs.get(t.lead.id)?.get(d) ?? []).filter((j) => j.holdsSlot).length, 0),
    extras: rows.filter((r) => r.day === d && r.extra && r.holdsSlot).length,
    toAllocate: units.filter((u) => u.days.some((x) => x.day === d)).length,
    pending: rows.filter((r) => r.day === d && r.extra && r.approval?.status === 'pending').length,
  }));
};

// ── how it is going ──────────────────────────────────────────────────────────

/** The figures behind "is the ERP's suggestion any good": acceptance, overrides, shadow match, extras, conflicts confirmed. */
export const allocationMetrics = async ({ from, to }) => {
  const range = { $gte: from, $lte: to };
  const rows = await ArtistAllocation.find({ day: range }).select('kind decision suggestion overrideReason extra approval conflictsConfirmed shadow teamId day unitKey bookingId active releasedReason').lean();
  const alloc = rows.filter((r) => r.kind === 'allocation' && r.releasedReason !== 'reallocated');
  const decided = alloc.filter((r) => r.decision !== 'reconciled');
  const count = (f) => decided.filter(f).length;
  const shadow = rows.filter((r) => r.kind === 'shadow' && r.shadow?.matched !== null && r.shadow?.matched !== undefined);
  const reasons = {};
  for (const r of decided.filter((x) => x.decision === 'override' && x.overrideReason)) reasons[r.overrideReason] = (reasons[r.overrideReason] ?? 0) + 1;
  const perTeam = {};
  for (const r of alloc.filter((x) => x.active && x.teamId)) perTeam[idOf(r.teamId)] = (perTeam[idOf(r.teamId)] ?? 0) + 1;
  const extras = alloc.filter((r) => r.extra);
  return {
    from, to,
    decided: decided.length,
    accepted: count((r) => r.decision === 'accepted'),
    overridden: count((r) => r.decision === 'override'),
    manual: count((r) => r.decision === 'manual'),
    top3: count((r) => Number(r.suggestion?.chosenRank) >= 1 && Number(r.suggestion?.chosenRank) <= 3),
    overrideReasons: reasons,
    shadow: { compared: shadow.length, matched: shadow.filter((r) => r.shadow.matched).length },
    extras: { requested: extras.length, approved: extras.filter((r) => r.approval?.status === 'approved').length, rejected: extras.filter((r) => r.approval?.status === 'rejected').length, pending: extras.filter((r) => r.approval?.status === 'pending').length },
    conflictsConfirmed: alloc.filter((r) => (r.conflictsConfirmed ?? []).length).length,
    perTeam,
  };
};

/** A day's load for each team (the Artist Management cards): jobs, slots used, free from, leave. */
export const teamsDayLoad = async (day, user) => {
  const board = await dayBoard(day, user);
  return new Map(board.teams.map((t) => [t.id, { day, status: t.status, used: t.used, of: t.of, jobs: t.jobs.map((j) => ({ bookingNumber: j.bookingNumber, start: j.start, label: j.place.label })), freeFrom: t.freeFrom, freeFromText: t.freeFromText, leave: t.leave }]));
};
