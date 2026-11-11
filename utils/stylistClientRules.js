// Pure rules for stylist client files — no database access, so every rule here
// is unit-tested offline (tests/stylistClients.test.js).
//
// A client file groups one client's consultation calls. Team N clients come
// from a CRM lead (and its booking) and are filled in from them; Nizan clients
// are not in the CRM, so the stylist types their details in.

export const CLIENT_COMPANIES = ['Team N', 'Nizan'];
export const CLIENT_STATUSES = ['Active', 'Completed', 'Cancelled'];
export const DEFAULT_REQUIRED_CALLS = 4;
export const MIN_REQUIRED_CALLS = 1;
export const MAX_REQUIRED_CALLS = 10;

// Calls that count towards the series. A cancelled call or a no-show doesn't
// use up a number — the next call takes it.
const COUNTED_STATUSES = new Set(['Scheduled', 'Completed']);

/// Free-text client fields and their maximum length.
export const CLIENT_TEXT_LIMITS = {
  name: 120,
  phone: 20,
  altPhone: 20,
  email: 120,
  eventType: 60,
  eventSlot: 60,
  venue: 300,
  district: 80,
  culture: 60,
  packageName: 200,
  bookingNumber: 40,
  outfitDetails: 1000,
  notes: 2000,
};

/// A stylist lead may open any client file; a stylist only their own.
export const canActOnClient = (access, user, client) => {
  if (access?.viewAll) return true;
  const owner = client?.stylistId?._id ?? client?.stylistId; // populated or not
  return owner != null && user?._id != null && String(owner) === String(user._id);
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const clean = (v) => String(v ?? '').trim();

const isPlaceholderEmail = (email) => clean(email).toLowerCase().endsWith('@placeholder.local');

/// IST calendar day of a Date as 'YYYY-MM-DD'.
const istDay = (d) => new Date(new Date(d).getTime() + 330 * 60000).toISOString().slice(0, 10);

const uniqueSorted = (days) => [...new Set(days.filter((d) => DAY_RE.test(d)))].sort();

/// The client-file fields for a Team N client, taken from its lead and (when
/// it has one) its booking. The booking wins where both have a value, since it
/// holds the confirmed details.
export const snapshotFromTeamN = (lead, booking = null) => {
  const items = Array.isArray(booking?.bookingItems) ? booking.bookingItems : [];

  const days = [
    ...(booking?.selectedDates ?? []),
    ...items.flatMap((it) => it?.selectedDates ?? []),
  ].map(clean);
  if (days.length === 0 && booking?.bookingDate) days.push(istDay(booking.bookingDate));
  if (days.length === 0 && lead?.eventDate) days.push(istDay(lead.eventDate));

  const artistNames = [];
  const addStaff = (arr) =>
    (arr ?? []).forEach((s) => {
      if (s && s.roleType !== 'driver' && clean(s.artistName)) artistNames.push(clean(s.artistName));
    });
  addStaff(booking?.assignedStaff);
  items.forEach((it) => addStaff(it?.assignedStaff));

  const packages = items.length
    ? items.map((it) => clean(it?.service)).filter(Boolean)
    : [clean(booking?.service)].filter(Boolean);
  const outfits = [clean(booking?.outfitDetails), ...items.map((it) => clean(it?.outfitDetails))].filter(Boolean);
  const slots = [clean(booking?.eventSlot), ...items.map((it) => clean(it?.eventSlot))].filter(Boolean);
  const email = [booking?.email, lead?.email].map(clean).find((e) => e && !isPlaceholderEmail(e)) ?? '';

  return {
    name: clean(booking?.customerName) || clean(lead?.name),
    phone: clean(booking?.phone) || clean(lead?.phone),
    altPhone: clean(booking?.secondaryContact) || clean(lead?.alternateNumber),
    email,
    eventType: clean(lead?.eventType),
    eventDates: uniqueSorted(days),
    eventSlot: [...new Set(slots)].join(', '),
    venue: clean(booking?.address) || clean(lead?.address) || clean(lead?.location),
    district: clean(booking?.district) || clean(lead?.district),
    culture: clean(booking?.culture),
    packageName: [...new Set(packages)].join(', '),
    bookingNumber: clean(booking?.bookingNumber),
    artistNames: [...new Set(artistNames)],
    outfitDetails: [...new Set(outfits)].join('\n'),
  };
};

/// Validates and cleans client details sent by the app. With [partial] only
/// the fields present are checked (an update). Returns { ok, value } or
/// { ok:false, message }.
export const cleanClientInput = (body, { partial = false } = {}) => {
  const b = body ?? {};
  const value = {};

  for (const [field, max] of Object.entries(CLIENT_TEXT_LIMITS)) {
    if (b[field] === undefined) continue;
    if (b[field] !== null && typeof b[field] !== 'string') {
      return { ok: false, message: `${field} must be text` };
    }
    const v = clean(b[field]);
    if (v.length > max) return { ok: false, message: `${field} is too long (max ${max} characters)` };
    value[field] = v;
  }

  if (b.eventDates !== undefined) {
    if (!Array.isArray(b.eventDates) || b.eventDates.length > 20) {
      return { ok: false, message: 'eventDates must be a list of up to 20 days' };
    }
    const days = b.eventDates.map(clean);
    if (days.some((d) => !DAY_RE.test(d) || Number.isNaN(new Date(`${d}T00:00:00Z`).getTime()))) {
      return { ok: false, message: 'eventDates must be YYYY-MM-DD days' };
    }
    value.eventDates = uniqueSorted(days);
  }

  if (b.artistNames !== undefined) {
    if (!Array.isArray(b.artistNames) || b.artistNames.length > 20 || b.artistNames.some((n) => typeof n !== 'string')) {
      return { ok: false, message: 'artistNames must be a list of names' };
    }
    value.artistNames = [...new Set(b.artistNames.map(clean).filter(Boolean))].map((n) => n.slice(0, 80));
  }

  if (b.status !== undefined) {
    if (!CLIENT_STATUSES.includes(b.status)) {
      return { ok: false, message: `status must be one of ${CLIENT_STATUSES.join(', ')}` };
    }
    value.status = b.status;
  }

  if (b.requiredCalls !== undefined) {
    const n = Number(b.requiredCalls);
    if (!Number.isInteger(n) || n < MIN_REQUIRED_CALLS || n > MAX_REQUIRED_CALLS) {
      return {
        ok: false,
        message: `requiredCalls must be a whole number from ${MIN_REQUIRED_CALLS} to ${MAX_REQUIRED_CALLS}`,
      };
    }
    value.requiredCalls = n;
  }

  if (!partial) {
    if (!value.name) return { ok: false, message: 'Client name is required' };
    if (!value.phone) return { ok: false, message: 'Client phone is required' };
  } else {
    if (value.name === '') return { ok: false, message: 'Client name cannot be empty' };
    if (value.phone === '') return { ok: false, message: 'Client phone cannot be empty' };
  }
  if (value.phone && value.phone.replace(/\D/g, '').length < 10) {
    return { ok: false, message: 'Enter a valid phone number' };
  }
  return { ok: true, value };
};

/// Call numbers for one client's calls: counted calls (scheduled or completed)
/// in time order get 1, 2, 3…; cancelled calls and no-shows get null.
/// Returns Map(id string → number | null).
export const numberCalls = (calls) => {
  const ordered = [...(calls ?? [])].sort(
    (a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime()
  );
  const numbers = new Map();
  let n = 0;
  for (const c of ordered) {
    numbers.set(String(c._id), COUNTED_STATUSES.has(c.status) ? ++n : null);
  }
  return numbers;
};

/// Progress of a client's series: completed calls, booked calls still ahead,
/// how many are required, and the next scheduled call (if any).
export const clientProgress = (calls, requiredCalls = DEFAULT_REQUIRED_CALLS, now = new Date()) => {
  const list = calls ?? [];
  const done = list.filter((c) => c.status === 'Completed').length;
  const upcoming = list
    .filter((c) => c.status === 'Scheduled' && new Date(c.scheduledAt).getTime() >= now.getTime())
    .sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());
  return {
    done,
    required: requiredCalls,
    booked: list.filter((c) => c.status === 'Scheduled').length,
    nextCallAt: upcoming[0]?.scheduledAt ?? null,
    nextCallId: upcoming[0]?._id ?? null,
  };
};
