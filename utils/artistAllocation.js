// SMART BOOKING ALLOCATION — which in-house artist team takes a new work (pure: no database, no network;
// tests/artistAllocation.test.js). The database half is services/artistAllocation.js.
//
// From management's "Smart Booking Allocation Strategy" (Method A — rotation + ERP suggestion):
//   • six in-house teams, each with 3 slots a day: 2 morning + 1 evening (18 a day; a peak day takes 2 EXTRA, needing the Artist
//     Head's OK);
//   • the first booking of an artist's day starts her route; after that, for each new booking the ERP checks
//       TIME      — can she finish the job she is on and be ready in time (and still make her next one)?
//       LOCATION  — is the new venue within 30 minutes' drive of the job she is on?
//     both pass → suggest the same artist (her route stays connected); either fails → the next free artist in the rotation;
//   • the ERP suggests, a coordinator confirms.
// The user's choices: "30" is DRIVE MINUTES (estimated); morning / evening by START TIME (before the cut-off, default 14:00 IST);
// a team = its main artist + her assistants, with preferred locations (districts / pincodes) that pick who starts a new route there.
//
// The unit allocated is one PACKAGE of a booking (or the whole booking when it has none) — staff is kept per package — over each of
// its work days. Times are minutes from midnight IST of the day ('HH:MM' in and out).

import { _coordsIn } from './mapLink.js';
import { driveMinutes } from './fleetAvailability.js';
import { istDayKey } from './istDate.js';
import { slotHalf } from './slots.js';

// ── settings ─────────────────────────────────────────────────────────────────

export const ALLOCATION_DEFAULTS = {
  eveningCutoff: '14:00', // a start before this (IST) takes a morning slot
  travelLimitMin: 30, // "within 30 minutes" — drive minutes between venues
  readyBufferMin: 30, // settling in / getting ready at the next venue
  defaultJobMin: 180, // a job with no (or a broken) end time
  unknownTravelMin: 90, // a drive that can't be estimated (no map pin / pincode) — for the time check only
  eveningAssumedStart: '16:00', // a job with no start time whose event reads as evening
  extrasPerDay: 2, // EXTRA slots a day, company-wide (bookings 19 and 20)
  extraWhen: 'half_full', // 'half_full': once every team's slots in that half are full; 'day_full': once every slot of the day is
};

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const pad = (n) => String(n).padStart(2, '0');
export const cleanHHMM = (s) => {
  const m = HHMM.exec(String(s ?? '').trim());
  return m ? `${pad(m[1])}:${m[2]}` : '';
};
const clampInt = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/** Settings as the allocator uses them: every value present and in range. */
export const normalizeSettings = (raw = {}) => ({
  eveningCutoff: cleanHHMM(raw.eveningCutoff) || ALLOCATION_DEFAULTS.eveningCutoff,
  travelLimitMin: clampInt(raw.travelLimitMin, 5, 240, ALLOCATION_DEFAULTS.travelLimitMin),
  readyBufferMin: clampInt(raw.readyBufferMin, 0, 180, ALLOCATION_DEFAULTS.readyBufferMin),
  defaultJobMin: clampInt(raw.defaultJobMin, 30, 720, ALLOCATION_DEFAULTS.defaultJobMin),
  unknownTravelMin: clampInt(raw.unknownTravelMin, 10, 600, ALLOCATION_DEFAULTS.unknownTravelMin),
  eveningAssumedStart: cleanHHMM(raw.eveningAssumedStart) || ALLOCATION_DEFAULTS.eveningAssumedStart,
  extrasPerDay: clampInt(raw.extrasPerDay, 0, 10, ALLOCATION_DEFAULTS.extrasPerDay),
  extraWhen: raw.extraWhen === 'day_full' ? 'day_full' : 'half_full',
});

// ── time ─────────────────────────────────────────────────────────────────────

export const toMin = (hhmm) => {
  const t = cleanHHMM(hhmm);
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
export const fromMin = (min) => {
  const m = Math.max(0, Math.min(24 * 60 - 1, Math.round(min)));
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
};
const IST_OFFSET_MS = 330 * 60 * 1000;
const istHHMM = (d) => {
  const t = new Date(d ?? NaN).getTime();
  return Number.isNaN(t) ? '' : new Date(t + IST_OFFSET_MS).toISOString().slice(11, 16);
};

/** "9:00 AM", "2:30 PM". */
export const fmtTime = (hhmm) => {
  const m = toMin(hhmm);
  if (m == null) return '';
  const h = Math.floor(m / 60);
  return `${h % 12 === 0 ? 12 : h % 12}:${pad(m % 60)} ${h < 12 ? 'AM' : 'PM'}`;
};
/** "12 min", "1 h 5 min", "over 3 h". */
export const fmtDuration = (min) => {
  const m = Math.max(1, Math.round(min));
  if (m < 60) return `${m} min`;
  if (m >= 180) return `over ${Math.floor(m / 60)} h`;
  return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`;
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "12 Dec". */
export const fmtDay = (day) => {
  const [, m, d] = String(day).split('-').map(Number);
  return m ? `${d} ${MONTHS[m - 1]}` : String(day);
};

/** Morning or evening: by the START TIME (before the cut-off = morning); with no time set, by the event's words. */
export const halfOf = ({ start, timeSet = true, eventSlot = '' }, cutoff = ALLOCATION_DEFAULTS.eveningCutoff) => {
  const s = toMin(start);
  if (timeSet && s != null) return s < toMin(cutoff) ? 'morning' : 'evening';
  return slotHalf(String(eventSlot).split('|')[0]);
};

// ── places ───────────────────────────────────────────────────────────────────

const idOf = (v) => (v == null ? '' : String(v._id ?? v));
/** A 6-digit pincode from the booking's pincode field or address (the same rule as utils/geocode.js pincodeOf). */
export const pinOf = (b) => {
  const direct = String(b?.pincode ?? '').replace(/\D/g, '');
  if (/^[1-9]\d{5}$/.test(direct)) return direct;
  const m = String(b?.address ?? '').match(/(?<!\d)([1-9]\d{2})\s?(\d{3})(?!\d)/);
  return m ? `${m[1]}${m[2]}` : '';
};
const dateMapOf = (b, day) => {
  const m = b?.dateMaps;
  if (!m) return '';
  return String((m instanceof Map ? m.get(day) : m[day]) ?? '');
};

/**
 * Where a package is on a day: { lat, lng, precision: 'pin' | 'pincode' | 'unknown', label, districtId, pincode }.
 * A map pin (the package's, the day's, the booking's) first; else the booking's pincode (when the package is in the booking's
 * district); else unknown. [ctx]: { coordsOfPin(pin) → {lat,lng}|null, districtOfPin(pin) → id|'', districtName(id) → '' }.
 */
export const placeOf = (booking, item, day, ctx = {}) => {
  const bookingDistrict = idOf(booking?.districtId);
  const districtId = idOf(item?.districtId) || bookingDistrict;
  const sameArea = !idOf(item?.districtId) || idOf(item?.districtId) === bookingDistrict;
  const pincode = sameArea ? pinOf(booking) : '';
  const district = districtId || (pincode ? (ctx.districtOfPin?.(pincode) ?? '') : '');
  const label = ctx.districtName?.(district) || (sameArea ? String(booking?.district || booking?.region || '').trim() : '') || (pincode ? `PIN ${pincode}` : 'the venue');
  const base = { districtId: district, pincode, label };
  const pins = [item?.mapUrl, sameArea ? dateMapOf(booking, day) || booking?.mapUrl : ''];
  for (const link of pins) {
    const c = link ? _coordsIn(link) : null;
    if (c && Number.isFinite(c.lat) && Number.isFinite(c.lng)) return { ...base, lat: c.lat, lng: c.lng, precision: 'pin' };
  }
  const c = pincode ? ctx.coordsOfPin?.(pincode) : null;
  if (c && Number.isFinite(c.lat) && Number.isFinite(c.lng)) return { ...base, lat: c.lat, lng: c.lng, precision: 'pincode' };
  return { ...base, lat: null, lng: null, precision: 'unknown' };
};

/** The drive between two places: { minutes, km, known, approx }. Same pincode = a short hop. */
export const driveBetween = (a, b) => {
  if (a?.pincode && a.pincode === b?.pincode && (a.precision !== 'pin' || b.precision !== 'pin')) return { minutes: 5, km: 2, known: true, approx: true };
  const d = driveMinutes(a?.precision === 'unknown' ? null : a, b?.precision === 'unknown' ? null : b);
  if (!d.known) return { minutes: null, km: null, known: false, approx: false };
  return { minutes: Math.max(1, Math.round(d.minutes)), km: Math.max(1, Math.round(d.km)), known: true, approx: a?.precision !== 'pin' || b?.precision !== 'pin' };
};

// ── a booking's work, as units ───────────────────────────────────────────────

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const daysIn = (list) => [...new Set((list ?? []).map(String).filter((d) => DAY.test(d)))].sort();

/**
 * A booking as allocation units: [{ bookingId, bookingNumber, customerName, unitKey, itemIndex, label, eventSlot, staff, days: [{ day,
 * start, end, startMin, endMin, timeSet, half, place }] }]. One unit per package ('i:<index>'), or 'b' for a booking with none.
 */
export const workUnits = (booking, ctx = {}, settingsRaw = {}) => {
  const st = normalizeSettings(settingsRaw);
  const baseDays = daysIn(booking?.selectedDates);
  const fallbackDay = booking?.serviceStart ?? booking?.bookingDate;
  const days0 = baseDays.length ? baseDays : !Number.isNaN(new Date(fallbackDay ?? NaN).getTime()) ? [istDayKey(fallbackDay)] : [];
  const baseStart = cleanHHMM(istHHMM(booking?.serviceStart));
  const baseEnd = cleanHHMM(istHHMM(booking?.serviceEnd));
  // 09:00–10:00 is what a booking saved without times gets (bookingController resolveSchedule) — not a real time
  const placeholder = !baseStart || (baseStart === '09:00' && baseEnd === '10:00');
  const items = Array.isArray(booking?.bookingItems) ? booking.bookingItems : [];
  const brief = { bookingId: idOf(booking?._id), bookingNumber: String(booking?.bookingNumber ?? ''), customerName: String(booking?.customerName ?? '') };

  const dayOf = (item, day) => {
    const ownStart = cleanHHMM(item?.startTime);
    const ownEnd = cleanHHMM(item?.endTime);
    const timeSet = !!ownStart || !placeholder;
    const eventSlot = String(item?.eventSlot || booking?.eventSlot || '');
    let start = ownStart || (placeholder ? '' : baseStart);
    if (!start) start = slotHalf(eventSlot.split('|')[0]) === 'evening' ? st.eveningAssumedStart : '09:00';
    let end = ownEnd || (ownStart || placeholder ? '' : baseEnd);
    let startMin = toMin(start);
    let endMin = toMin(end);
    if (endMin == null || endMin <= startMin) endMin = Math.min(24 * 60 - 1, startMin + st.defaultJobMin);
    end = fromMin(endMin);
    return { day, start, end, startMin, endMin, timeSet, half: halfOf({ start, timeSet, eventSlot }, st.eveningCutoff), place: placeOf(booking, item, day, ctx) };
  };

  if (items.length === 0) {
    return [{ ...brief, unitKey: 'b', itemIndex: -1, label: String(booking?.service || booking?.serviceName || 'Booking'), eventSlot: String(booking?.eventSlot ?? ''), staff: booking?.assignedStaff ?? [], days: days0.map((d) => dayOf(null, d)) }];
  }
  return items.map((item, i) => {
    const own = daysIn(item?.selectedDates);
    const staff = (item?.assignedStaff ?? []).length ? item.assignedStaff : booking?.assignedStaff ?? [];
    return { ...brief, unitKey: `i:${i}`, itemIndex: i, label: String(item?.service || item?.packageName || `Package ${i + 1}`), eventSlot: String(item?.eventSlot ?? ''), staff, days: (own.length ? own : days0).map((d) => dayOf(item, d)) };
  });
};

// ── who is out where: the jobs of each person ────────────────────────────────

/** Bookings that are not happening never hold anyone. A pending booking that already has staff on it does. */
export const ALLOCATION_EXCLUDED = new Set(['cancelled', 'canceled', 'rejected', 'lost', 'postponed', 'draft']);
export const isAllocatable = (b) => !ALLOCATION_EXCLUDED.has(String(b?.status ?? '').trim().toLowerCase());

const overlaps = (a, b) => a.startMin < b.endMin && b.startMin < a.endMin;

/**
 * Every person's jobs per day from [units] (of OTHER bookings): Map(employeeId → Map(day → [job])). A job is { bookingId,
 * bookingNumber, customerName, unitKey, day, start, end, startMin, endMin, half, place, holdsSlot } — holdsSlot when she is its LEAD.
 * Overlapping jobs of the same booking for the same person are one job (the bride and her family made up together: one slot).
 */
export const jobsByEmployee = (units) => {
  const out = new Map();
  for (const u of units) {
    for (const d of u.days) {
      for (const s of u.staff ?? []) {
        if (!s?.employeeId || s.roleType === 'driver') continue;
        const id = idOf(s.employeeId);
        if (!out.has(id)) out.set(id, new Map());
        const byDay = out.get(id);
        if (!byDay.has(d.day)) byDay.set(d.day, []);
        const list = byDay.get(d.day);
        const job = { bookingId: u.bookingId, bookingNumber: u.bookingNumber, customerName: u.customerName, unitKey: u.unitKey, day: d.day, start: d.start, end: d.end, startMin: d.startMin, endMin: d.endMin, half: d.half, place: d.place, holdsSlot: s.roleType === 'lead' };
        const same = list.find((j) => j.bookingId === job.bookingId && overlaps(j, job));
        if (same) {
          same.startMin = Math.min(same.startMin, job.startMin);
          same.endMin = Math.max(same.endMin, job.endMin);
          same.start = fromMin(same.startMin);
          same.end = fromMin(same.endMin);
          same.holdsSlot = same.holdsSlot || job.holdsSlot;
        } else list.push(job);
      }
    }
  }
  for (const byDay of out.values()) for (const list of byDay.values()) list.sort((a, b) => a.startMin - b.startMin);
  return out;
};

/** The approved leave covering [day]: { halfDay: 'none'|'first'|'second' } | null. */
const leaveOn = (leaves, day) => (leaves ?? []).find((l) => l.fromDay <= day && day <= l.toDay) ?? null;

// ── one team, one day ────────────────────────────────────────────────────────

export const TIER_ORDER = ['continue', 'new_route', 'far', 'extra', 'blocked'];
const tierRank = (t) => TIER_ORDER.indexOf(t);

const placeLabel = (job) => job?.place?.label || 'the venue';

/** How many of her slot-holding [jobs] of a day go past her plan (per half: jobs beyond its slots). */
const overPlanOf = (team, jobs) =>
  ['morning', 'evening'].reduce((n, h) => n + Math.max(0, jobs.filter((j) => j.holdsSlot && j.half === h).length - Math.max(0, Number(team.slots?.[h] ?? (h === 'morning' ? 2 : 1)))), 0);

/**
 * How team [team] stands for the new job [nj] (one day of a unit) — { tier, reason, problems, warnings, slot, travel, anchor, ... }.
 * [state] = { jobs: jobsByEmployee, leaves: Map(empId → [{fromDay,toDay,halfDay}]), extrasUsed: Map(day → n) }.
 */
export const evaluateTeamDay = ({ team, unit, nj, state, settings }) => {
  const st = normalizeSettings(settings);
  const leadId = idOf(team.lead?._id ?? team.lead?.id ?? team.leadEmployeeId);
  const leadName = team.lead?.name || team.name || 'She';
  const problems = [];
  const warnings = [];
  const block = (reason) => ({ tier: 'blocked', reason, problems: [...problems, reason], warnings, slot: null, travel: null, anchor: null });

  // availability
  if (team.lead && team.lead.status && team.lead.status !== 'active') return block(`${leadName} is no longer active`);
  const leave = leaveOn(state.leaves?.get(leadId), nj.day);
  if (leave) {
    const half = leave.halfDay === 'first' ? 'morning' : leave.halfDay === 'second' ? 'evening' : null;
    if (!half) return block(`${leadName} is on leave on ${fmtDay(nj.day)}`);
    if (half === nj.half) return block(`${leadName} is on a half-day leave (${half}) on ${fmtDay(nj.day)}`);
    warnings.push(`${leadName} has a half-day leave (${half}) on ${fmtDay(nj.day)}`);
  }

  const all = state.jobs?.get(leadId)?.get(nj.day) ?? [];
  // her jobs of THIS booking that overlap the new one: made up together — no new slot, no clash
  const merged = all.filter((j) => j.bookingId === unit.bookingId && overlaps(j, nj));
  const others = all.filter((j) => !merged.includes(j));
  const clash = others.find((j) => overlaps(j, nj));
  if (clash) return block(`Already on #${clash.bookingNumber || '—'} ${fmtTime(clash.start)}–${fmtTime(clash.end)}`);

  const prev = [...others].filter((j) => j.endMin <= nj.startMin).sort((a, b) => b.endMin - a.endMin)[0] ?? null;
  const next = [...others].filter((j) => j.startMin >= nj.endMin).sort((a, b) => a.startMin - b.startMin)[0] ?? null;

  // TIME — both ways: from the job before, and on to the job after
  const leg = (from, to) => {
    const d = driveBetween(from.place, to.place);
    return { ...d, used: d.known ? d.minutes : st.unknownTravelMin };
  };
  let fromPrev = null;
  if (prev) {
    fromPrev = leg(prev, nj);
    const readyAt = prev.endMin + fromPrev.used + st.readyBufferMin;
    if (readyAt > nj.startMin) {
      return block(`Can't be ready: her ${fmtTime(prev.start)} job ends ${fmtTime(prev.end)}, ${fmtDuration(fromPrev.used)}${fromPrev.known ? '' : ' (estimated)'} drive + ${st.readyBufferMin} min ready → ${fmtTime(fromMin(readyAt))}; this starts ${fmtTime(nj.start)}`);
    }
  }
  let toNext = null;
  if (next) {
    toNext = leg(nj, next);
    const readyAt = nj.endMin + toNext.used + st.readyBufferMin;
    if (readyAt > next.startMin) {
      return block(`Can't make her ${fmtTime(next.start)} ${placeLabel(next)} job: this ends ${fmtTime(nj.end)}, ${fmtDuration(toNext.used)}${toNext.known ? '' : ' (estimated)'} drive + ${st.readyBufferMin} min → ${fmtTime(fromMin(readyAt))}`);
    }
  }

  // assistants: a clash or a leave is only a warning (the coordinator swaps her)
  for (const a of team.assistants ?? []) {
    const aid = idOf(a._id ?? a.id);
    const aLeave = leaveOn(state.leaves?.get(aid), nj.day);
    if (aLeave && (aLeave.halfDay === 'none' || !aLeave.halfDay)) warnings.push(`${a.name} is on leave on ${fmtDay(nj.day)} — change assistant`);
    const aClash = (state.jobs?.get(aid)?.get(nj.day) ?? []).find((j) => j.bookingId !== unit.bookingId && overlaps(j, nj));
    if (aClash) warnings.push(`${a.name} is on #${aClash.bookingNumber || '—'} at ${fmtTime(aClash.start)} — change assistant`);
  }

  // SLOT — her slot-holding jobs in this half (merged jobs of this booking excluded: no new slot)
  const capacity = Math.max(0, Number(team.slots?.[nj.half] ?? (nj.half === 'morning' ? 2 : 1)));
  const used = others.filter((j) => j.holdsSlot && j.half === nj.half).length;
  const needsSlot = merged.length === 0 || !merged.some((j) => j.holdsSlot);
  const slot = { half: nj.half, used, of: capacity, free: !needsSlot || used < capacity, needsSlot };

  // LOCATION — the job she is on: the one before, else the one after
  const anchor = prev ?? next;
  const anchorLeg = prev ? fromPrev : toNext;
  const travel = anchor ? { minutes: anchorLeg.known ? anchorLeg.minutes : null, km: anchorLeg.km, known: anchorLeg.known, approx: anchorLeg.approx, from: { bookingNumber: anchor.bookingNumber, start: anchor.start, label: placeLabel(anchor) }, direction: prev ? 'from' : 'to' } : null;
  const near = !!anchor && anchorLeg.known && anchorLeg.minutes <= st.travelLimitMin;
  const nearText = () => {
    const km = anchorLeg.km ? ` (${anchorLeg.km} km)` : '';
    const approx = anchorLeg.approx ? ' by pincode' : '';
    return prev
      ? `Same area as her ${fmtTime(prev.start)} ${placeLabel(prev)} job — ${fmtDuration(anchorLeg.minutes)}${km} away${approx}`
      : `Close to her ${fmtTime(next.start)} ${placeLabel(next)} job — ${fmtDuration(anchorLeg.minutes)}${km} away${approx}`;
  };
  const farText = () => {
    if (nj.place?.precision === 'unknown') return 'Couldn\'t place this venue (no map pin or pincode) — add one for a better suggestion';
    if (!anchorLeg.known) return `Couldn't place her ${fmtTime(anchor.start)} job — add its map pin or pincode`;
    return `${placeLabel(nj)} is ${fmtDuration(anchorLeg.minutes)} from her ${fmtTime(anchor.start)} ${placeLabel(anchor)} job (she has time)`;
  };

  const base = { problems, warnings, slot, travel, anchor: anchor ? { bookingNumber: anchor.bookingNumber, start: anchor.start, end: anchor.end, label: placeLabel(anchor) } : null, jobsThatDay: others.length };

  if (!slot.free) {
    const halfWord = nj.half === 'morning' ? (capacity === 2 ? 'Both morning slots' : capacity === 1 ? 'Her morning slot' : 'Morning slots') : capacity === 1 ? 'Her evening slot' : 'Evening slots';
    const fullReason = capacity === 0 ? `No ${nj.half} slot in her day` : `${halfWord} taken`;
    // at most ONE work past her plan a day (her "4th work")
    if (overPlanOf(team, others) >= 1) {
      const r = `${leadName} already has a work past her slots that day`;
      return { ...base, tier: 'blocked', reason: r, problems: [...problems, r] };
    }
    // an EXTRA (4th) slot: only for a route that fits — the same area and the clock both pass
    if (team.extraAllowed !== false && near) return { ...base, tier: 'extra', fullReason, reason: '' , nearReason: nearText() };
    return { ...base, tier: 'blocked', reason: fullReason, problems: [...problems, fullReason] };
  }
  if (others.length === 0) return { ...base, tier: 'new_route', reason: '' };
  if (near) return { ...base, tier: 'continue', reason: nearText() };
  return { ...base, tier: 'far', reason: farText() };
};

// ── rotation and preferred places ─────────────────────────────────────────────

/** The teams in rotation order, starting just after the team that last started a route. */
export const rotationFrom = (teams, lastStartedTeamId) => {
  const ordered = [...teams].sort((a, b) => (a.rotationOrder ?? 0) - (b.rotationOrder ?? 0) || String(a.id).localeCompare(String(b.id)));
  const at = ordered.findIndex((t) => String(t.id) === String(lastStartedTeamId ?? ''));
  return at < 0 ? ordered : [...ordered.slice(at + 1), ...ordered.slice(0, at + 1)];
};

/** How well the venue matches a team's preferred places: 2 = her pincode area, 1 = her district, 0 = neither. */
export const preferenceScore = (team, place) => {
  if (place?.pincode && (team.preferredPincodes ?? []).map(String).includes(place.pincode)) return 2;
  if (place?.districtId && (team.preferredDistrictIds ?? []).map(idOf).includes(String(place.districtId))) return 1;
  return 0;
};

// ── ranking the teams for a unit ──────────────────────────────────────────────

const ordinal = (n) => `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`;

/**
 * Every active team ranked for [unit] — best first. → [{ teamId, teamName, lead, assistants, tier, rank, recommended, reason, details,
 * problems, warnings, slots: [{day, half, used, of}], extra, needsApproval, travel, preferred }]
 * [state] = { teams, jobs, leaves, extrasUsed: Map(day→n), lastStartedTeamId }.
 */
export const rankCandidates = ({ unit, state, settings }) => {
  const st = normalizeSettings(settings);
  const teams = (state.teams ?? []).filter((t) => t.active !== false);
  const order = rotationFrom(teams, state.lastStartedTeamId);
  const rotationIndex = new Map(order.map((t, i) => [String(t.id), i]));

  // each team, each day
  const perTeam = teams.map((team) => ({ team, days: unit.days.map((nj) => ({ nj, v: evaluateTeamDay({ team, unit, nj, state, settings: st }) })) }));

  // an EXTRA is only offered when no team has a normal slot that day (in that half, or at all with 'day_full'), and extras remain
  const normalTiers = new Set(['continue', 'new_route', 'far']);
  const roomOnDay = (day, half) =>
    perTeam.some(({ days }) => days.some(({ nj, v }) => nj.day === day && normalTiers.has(v.tier))) ||
    (st.extraWhen === 'day_full' &&
      teams.some((t) => {
        const leadId = idOf(t.lead?._id ?? t.lead?.id ?? t.leadEmployeeId);
        const jobs = state.jobs?.get(leadId)?.get(day) ?? [];
        return ['morning', 'evening'].filter((h) => h !== half).some((h) => jobs.filter((j) => j.holdsSlot && j.half === h).length < Number(t.slots?.[h] ?? (h === 'morning' ? 2 : 1)));
      }));
  for (const { days } of perTeam) {
    for (const d of days) {
      if (d.v.tier !== 'extra') continue;
      const used = state.extrasUsed?.get(d.nj.day) ?? 0;
      if (used >= st.extrasPerDay) {
        d.v = { ...d.v, tier: 'blocked', reason: `${d.v.fullReason} — and both extra slots for ${fmtDay(d.nj.day)} are used`, problems: [...d.v.problems, d.v.fullReason] };
      } else if (roomOnDay(d.nj.day, d.nj.half)) {
        d.v = { ...d.v, tier: 'blocked', reason: `${d.v.fullReason} (other artists are free)`, problems: [...d.v.problems, d.v.fullReason] };
      } else {
        d.v = { ...d.v, extraNo: used + 1, reason: `EXTRA ${ordinal(Number(d.v.slot.of) + 1)} slot — every ${d.nj.half} slot is full; ${d.v.nearReason.replace(/^Same area as /, '').replace(/^Close to /, '')}. Needs the Artist Head's OK` };
      }
    }
  }

  const ranked = perTeam.map(({ team, days }) => {
    const worst = days.reduce((w, d) => (tierRank(d.v.tier) > tierRank(w.v.tier) ? d : w), days[0] ?? { v: { tier: 'blocked', reason: 'No work day on this booking', problems: [], warnings: [] }, nj: null });
    const tier = days.length ? worst.v.tier : 'blocked';
    const pref = Math.max(0, ...unit.days.map((nj) => preferenceScore(team, nj.place)));
    let reason = worst.v.reason;
    if (tier === 'new_route') {
      const placeName = unit.days[0]?.place?.label;
      reason = pref > 0 ? `Starts a new route — prefers ${placeName}` : 'Starts a new route — next in rotation';
    }
    const multi = days.length > 1;
    const details = multi ? days.map(({ nj, v }) => `${fmtDay(nj.day)}: ${v.tier === 'new_route' ? 'starts a new route' : v.reason}`) : [];
    if (multi && tier === 'blocked') reason = `${fmtDay(worst.nj.day)}: ${worst.v.reason}`;
    const extraDay = days.find((d) => d.v.tier === 'extra');
    const minutes = days.map((d) => d.v.travel?.minutes).filter((m) => Number.isFinite(m));
    return {
      teamId: String(team.id),
      teamName: team.name || `Team ${team.lead?.name ?? ''}`.trim(),
      rotationOrder: team.rotationOrder ?? 0,
      lead: team.lead ? { id: idOf(team.lead._id ?? team.lead.id), name: team.lead.name ?? '' } : null,
      assistants: (team.assistants ?? []).map((a) => ({ id: idOf(a._id ?? a.id), name: a.name ?? '' })),
      tier,
      reason,
      details,
      problems: days.flatMap((d) => d.v.problems ?? []),
      warnings: [...new Set(days.flatMap((d) => d.v.warnings ?? []))],
      slots: days.map(({ nj, v }) => ({ day: nj.day, half: nj.half, used: v.slot?.used ?? null, of: v.slot?.of ?? null, needsSlot: v.slot?.needsSlot ?? true })),
      extra: extraDay ? { day: extraDay.nj.day, extraNo: extraDay.v.extraNo } : null,
      needsApproval: tier === 'extra',
      travel: days.find((d) => d.v.travel)?.v.travel ?? null,
      preferred: pref,
      _sort: { anchorMin: minutes.length ? Math.max(...minutes) : 9999, jobs: Math.max(0, ...days.map((d) => d.v.jobsThatDay ?? 0)), rot: rotationIndex.get(String(team.id)) ?? 99 },
    };
  });

  ranked.sort((a, b) => {
    const t = tierRank(a.tier) - tierRank(b.tier);
    if (t) return t;
    if (a.tier === 'continue') return a._sort.anchorMin - b._sort.anchorMin || a._sort.jobs - b._sort.jobs || a._sort.rot - b._sort.rot;
    if (a.tier === 'new_route') return b.preferred - a.preferred || a._sort.rot - b._sort.rot;
    if (a.tier === 'far' || a.tier === 'extra') return a._sort.anchorMin - b._sort.anchorMin || a._sort.rot - b._sort.rot;
    return a._sort.rot - b._sort.rot;
  });
  const firstOk = ranked.findIndex((c) => c.tier !== 'blocked');
  return ranked.map(({ _sort, ...c }, i) => ({ ...c, rank: i + 1, recommended: i === firstOk }));
};

// ── a plan for several units (bulk confirm, the Board's "Suggest all") ────────

/** A copy of [state] with [unit] given to [team] (her jobs, her assistants', the extras count, the rotation pointer). */
// ── a full day: where a 4th work could still go (time + route) ─────────────

/** The working day the gap finder looks in (an early bride to a late reception). */
export const WORK_DAY = { start: '05:00', end: '22:00' };

/**
 * For a new work at [nj] (its place, and its length nj.endMin − nj.startMin) on a day: each team's free windows where it fits — between
 * her works (or before the first / after the last), leaving the drive from the work before and to the work after plus the ready time —
 * and ONLY close to her works (each drive within the travel limit, so her day stays one tight route). A team on leave that day, or one
 * that already has a work past her slots, has none. → [{ teamId, teamName, lead, assistants, jobs, windows: [{ from, to, fromMin, toMin,
 * after, before, reason }] }] (teams with no window left out), each team's windows in time order.
 */
export const fourthWorkWindows = ({ nj, state, settings }) => {
  const st = normalizeSettings(settings);
  const need = Math.max(30, (nj.endMin ?? 0) - (nj.startMin ?? 0));
  const dayStart = toMin(WORK_DAY.start);
  const dayEnd = toMin(WORK_DAY.end);
  const out = [];
  for (const team of (state.teams ?? []).filter((t) => t.active !== false)) {
    const leadId = idOf(team.lead?._id ?? team.lead?.id ?? team.leadEmployeeId);
    if (team.lead?.status && team.lead.status !== 'active') continue;
    if (leaveOn(state.leaves?.get(leadId), nj.day)) continue;
    const jobs = [...(state.jobs?.get(leadId)?.get(nj.day) ?? [])].sort((x, y) => x.startMin - y.startMin);
    if (overPlanOf(team, jobs) >= 1) continue;
    const windows = [];
    for (let i = 0; i <= jobs.length; i += 1) {
      const prev = jobs[i - 1] ?? null;
      const next = jobs[i] ?? null;
      if (!prev && !next) continue; // a free day is a new route, not a 4th work
      const into = prev ? driveBetween(prev.place, nj.place) : null;
      const outOf = next ? driveBetween(nj.place, next.place) : null;
      // close to her works only: every drive known and within the limit
      if ((into && (!into.known || into.minutes > st.travelLimitMin)) || (outOf && (!outOf.known || outOf.minutes > st.travelLimitMin))) continue;
      const fromMin_ = prev ? prev.endMin + into.minutes + st.readyBufferMin : dayStart;
      const toMin_ = next ? next.startMin - outOf.minutes - st.readyBufferMin : dayEnd;
      if (toMin_ - fromMin_ < need) continue;
      const near = prev
        ? `${fmtDuration(into.minutes)} from her ${fmtTime(prev.start)} ${placeLabel(prev)} job`
        : `${fmtDuration(outOf.minutes)} before her ${fmtTime(next.start)} ${placeLabel(next)} job`;
      windows.push({
        from: fromMin(fromMin_), to: fromMin(toMin_), fromMin: fromMin_, toMin: toMin_,
        after: prev ? { start: prev.start, end: prev.end, label: placeLabel(prev) } : null,
        before: next ? { start: next.start, label: placeLabel(next) } : null,
        reason: near,
      });
    }
    if (windows.length) {
      out.push({
        teamId: String(team.id), teamName: team.name || `Team ${team.lead?.name ?? ''}`.trim(), rotationOrder: team.rotationOrder ?? 0,
        lead: team.lead?.name ?? '', assistants: (team.assistants ?? []).map((x) => x.name ?? ''), jobs: jobs.length, windows,
      });
    }
  }
  return out.sort((x, y) => x.windows[0].fromMin - y.windows[0].fromMin || x.rotationOrder - y.rotationOrder);
};

// ── automatic allocation: is the top suggestion clean enough to give without a person? ─────────────────────

/**
 * The ERP gives a package to a team on its own only for a CLEAN match — the user's rule:
 *   • the same area as her other job that day (both time checks pass, within the travel limit, a slot free), or
 *   • an artist free that day whose preferred locations hold the venue's pincode or district (and the venue has a pincode or map pin).
 * Anything doubtful — every slot full (an extra), a far or unplaced venue, no start time, no artist preferring the place, an assistant who
 * is busy — waits for CRM on the Allocation Board, with the reason. → { ok: true, cand } | { ok: false, reason }
 */
export const autoPick = ({ unit, candidates }) => {
  // (no team recommended = every one is blocked: the first says why)
  const top = (candidates ?? []).find((c) => c.recommended) ?? candidates?.[0] ?? null;
  const days = unit?.days ?? [];
  if (!days.length) return { ok: false, reason: 'The booking has no work day' };
  if (!top) return { ok: false, reason: 'No artist team is set up yet' };
  if (top.tier === 'blocked') return { ok: false, reason: `No team is free for it — ${top.reason}` };
  if (days.some((d) => !d.timeSet)) return { ok: false, reason: 'The booking has no start time — add it so the route can be checked' };
  if (top.tier === 'extra') {
    const half = days.find((d) => d.day === top.extra?.day)?.half ?? days[0].half;
    return { ok: false, reason: `Every ${half} slot that day is full — CRM decides (an extra slot needs the Artist Head's OK)` };
  }
  if (days.some((d) => !d.place?.pincode && d.place?.precision !== 'pin')) return { ok: false, reason: 'The venue has no pincode or map pin — add one so the route can be checked' };
  if (top.tier === 'far') return { ok: false, reason: `Not a close match — ${top.reason}` };
  if (top.tier === 'new_route' && !(top.preferred > 0)) {
    return { ok: false, reason: `No free artist has ${days[0].place?.label || 'this place'} as a preferred location — CRM picks the artist (or add it to a team in Artist Management)` };
  }
  if (top.tier !== 'continue' && top.tier !== 'new_route') return { ok: false, reason: top.reason || 'Not a clean match' };
  const busyAssistant = (top.warnings ?? []).find((w) => /change assistant$/.test(w));
  if (busyAssistant) return { ok: false, reason: `${top.teamName} fits, but ${busyAssistant.replace(/ — change assistant$/, '')} — CRM checks the assistants` };
  return { ok: true, cand: top };
};

export const withAllocation = (state, unit, team, cand) => {
  const jobs = new Map([...(state.jobs ?? new Map())].map(([k, v]) => [k, new Map([...v].map(([d, l]) => [d, [...l]]))]));
  const put = (empId, nj, holdsSlot) => {
    if (!jobs.has(empId)) jobs.set(empId, new Map());
    const byDay = jobs.get(empId);
    if (!byDay.has(nj.day)) byDay.set(nj.day, []);
    byDay.get(nj.day).push({ bookingId: unit.bookingId, bookingNumber: unit.bookingNumber, customerName: unit.customerName, unitKey: unit.unitKey, day: nj.day, start: nj.start, end: nj.end, startMin: nj.startMin, endMin: nj.endMin, half: nj.half, place: nj.place, holdsSlot });
    byDay.get(nj.day).sort((a, b) => a.startMin - b.startMin);
  };
  for (const nj of unit.days) {
    put(idOf(team.lead?._id ?? team.lead?.id ?? team.leadEmployeeId), nj, true);
    for (const a of team.assistants ?? []) put(idOf(a._id ?? a.id), nj, false);
  }
  const extrasUsed = new Map(state.extrasUsed ?? []);
  if (cand?.tier === 'extra' && cand.extra) extrasUsed.set(cand.extra.day, (extrasUsed.get(cand.extra.day) ?? 0) + 1);
  return { ...state, jobs, extrasUsed, lastStartedTeamId: cand?.tier === 'new_route' ? String(team.id) : state.lastStartedTeamId };
};

/**
 * Suggestions for several units, one after another in time order — each one counting the ones before it (so B1, B2, B3 of a day come
 * out as one route, then the next). → [{ unit, candidates, pick }]
 */
export const planUnits = ({ units, state, settings }) => {
  const order = [...units].sort((a, b) => (a.days[0]?.day ?? '').localeCompare(b.days[0]?.day ?? '') || (a.days[0]?.startMin ?? 0) - (b.days[0]?.startMin ?? 0) || String(a.bookingNumber).localeCompare(String(b.bookingNumber)));
  let s = state;
  const out = [];
  for (const unit of order) {
    const candidates = rankCandidates({ unit, state: s, settings });
    const pick = candidates.find((c) => c.recommended) ?? null;
    if (pick) {
      const team = (s.teams ?? []).find((t) => String(t.id) === pick.teamId);
      s = withAllocation(s, unit, team, pick);
    }
    out.push({ unit, candidates, pick });
  }
  return { plan: out, state: s };
};

/** The state the allocator works from, built from the other bookings' units. */
export const buildState = ({ teams, otherUnits, leaves, extrasUsed, lastStartedTeamId }) => ({
  teams: (teams ?? []).filter((t) => t.active !== false),
  jobs: jobsByEmployee(otherUnits ?? []),
  leaves: leaves ?? new Map(),
  extrasUsed: extrasUsed ?? new Map(),
  lastStartedTeamId: lastStartedTeamId ?? null,
});
