import AllocationSettings from '../models/AllocationSettings.js';
import { cleanHHMM, normalizeSettings } from '../utils/artistAllocation.js';

// The smart booking allocation's settings — one record, made the first time anything asks.

const env = (k) => String(process.env[k] ?? '').trim().toLowerCase();

export const getAllocationSettings = async () =>
  AllocationSettings.findOneAndUpdate({ singleton: 'allocation' }, { $setOnInsert: { singleton: 'allocation' } }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();

/** The mode in force: the env kill switch ARTIST_ALLOCATION=off wins over the setting. */
export const modeOf = (s) => (env('ARTIST_ALLOCATION') === 'off' ? 'off' : s?.mode ?? 'off');
/** Does the ERP give clean matches on its own (setting autoAllocate, with mode suggest; env ARTIST_AUTO_ALLOCATE=off wins)? */
export const autoOn = (s) => modeOf(s) === 'suggest' && s?.autoAllocate === 'on' && env('ARTIST_AUTO_ALLOCATE') !== 'off';
/** Is the clash guard on (the setting, unless switched off on the server)? */
export const guardOn = (s) => modeOf(s) === 'suggest' && s?.guard === 'on' && env('ARTIST_ASSIGNMENT_GUARD') !== 'off';

const idTime = (id) => {
  try {
    return typeof id?.getTimestamp === 'function' ? id.getTimestamp() : new Date(parseInt(String(id).slice(0, 8), 16) * 1000);
  } catch {
    return null;
  }
};

/**
 * Is [booking] a NEW booking for the allocation — made, or confirmed, at or after [since] (when suggest went live)? Bookings from
 * before keep their artists as they are (no suggestions, no guard, no slots of their own) — they only count as busy time. The booking's
 * own creation moment is read from its id (createdAt can be back-dated to the day the client booked).
 */
export const isNewBooking = (booking, since) => {
  if (!since || !booking) return false;
  // an id carries its moment to the second: a booking made in the go-live second counts as new
  const t = Math.floor(new Date(since).getTime() / 1000) * 1000;
  const made = idTime(booking._id);
  if (made && made.getTime() >= t) return true;
  return (booking.statusHistory ?? []).some((h) => String(h?.status ?? '').toLowerCase() === 'confirmed' && h.at && new Date(h.at).getTime() >= t);
};

/** The settings a person may change, checked. → { ok, value } | { ok: false, message } */
export const cleanSettingsInput = (b = {}, { mayChangeMode = false } = {}) => {
  const out = {};
  if (b.mode !== undefined) {
    if (!mayChangeMode) return { ok: false, message: 'Only an admin or manager can switch the allocation on or off.' };
    if (!['off', 'shadow', 'suggest'].includes(b.mode)) return { ok: false, message: 'The mode is off, shadow or suggest.' };
    out.mode = b.mode;
  }
  if (b.guard !== undefined) {
    if (!mayChangeMode) return { ok: false, message: 'Only an admin or manager can switch the clash check on or off.' };
    if (!['off', 'on'].includes(b.guard)) return { ok: false, message: 'The clash check is on or off.' };
    out.guard = b.guard;
  }
  if (b.autoAllocate !== undefined) {
    if (!mayChangeMode) return { ok: false, message: 'Only an admin or manager can switch automatic allocation on or off.' };
    if (!['off', 'on'].includes(b.autoAllocate)) return { ok: false, message: 'Automatic allocation is on or off.' };
    out.autoAllocate = b.autoAllocate;
  }
  for (const k of ['eveningCutoff', 'eveningAssumedStart']) {
    if (b[k] === undefined) continue;
    const t = cleanHHMM(b[k]);
    if (!t) return { ok: false, message: 'Times are HH:MM, like 14:00.' };
    out[k] = t;
  }
  const n = normalizeSettings(b);
  const ranges = { travelLimitMin: [5, 240], readyBufferMin: [0, 180], defaultJobMin: [30, 720], unknownTravelMin: [10, 600], extrasPerDay: [0, 10] };
  for (const [k, [lo, hi]] of Object.entries(ranges)) {
    if (b[k] === undefined) continue;
    const v = Number(b[k]);
    if (!Number.isFinite(v) || v < lo || v > hi) return { ok: false, message: `${k} must be between ${lo} and ${hi}.` };
    out[k] = n[k];
  }
  if (b.extraWhen !== undefined) {
    if (!['half_full', 'day_full'].includes(b.extraWhen)) return { ok: false, message: 'Extras come once a half is full, or the whole day.' };
    out.extraWhen = b.extraWhen;
  }
  return { ok: true, value: out };
};

/** Saves [value]; the first switch to suggest stamps liveSince (and to shadow, shadowSince). */
export const saveAllocationSettings = async (value, user) => {
  const now = new Date();
  const cur = await getAllocationSettings();
  const set = { ...value, updatedBy: user?._id ?? null, updatedByName: user?.name ?? '' };
  if (value.mode === 'suggest' && !cur.liveSince) set.liveSince = now;
  if (value.mode === 'shadow' && !cur.shadowSince) set.shadowSince = now;
  return AllocationSettings.findOneAndUpdate({ singleton: 'allocation' }, { $set: set }, { new: true }).lean();
};

/** The rotation pointer moves to [teamId] (the team that just started a route). Last write wins — a soft fairness rule. */
export const moveRotation = (teamId) => AllocationSettings.updateOne({ singleton: 'allocation' }, { $set: { 'rotation.lastStartedTeamId': teamId, 'rotation.lastStartedAt': new Date() } });
