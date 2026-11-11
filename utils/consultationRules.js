// Pure business rules for stylist consultations (no database, no Express) so the
// access, validation, overlap and status logic can be unit tested on its own:
//   node --test tests/consultationRules.test.js

export const CONSULTATION_STATUSES = ['Scheduled', 'Completed', 'Cancelled', 'No-show'];
export const CONSULTATION_MODES = ['Video', 'In-person'];
export const MEETING_PROVIDERS = ['Google Meet', 'Zoom', 'Other'];

export const DEFAULT_DURATION_MINS = 45;
export const MIN_DURATION_MINS = 5;
export const MAX_DURATION_MINS = 480;
export const MAX_LINK_LENGTH = 500;

const MINUTE_MS = 60000;
// An ISO timestamp that carries its own zone ("…Z" or "…+05:30"). A zone-less
// string would be read in the server's timezone, so it is rejected.
const HAS_ZONE_RE = /(Z|[+-]\d{2}:?\d{2})$/i;

// ── Input limits ────────────────────────────────────────────────────────────
// Free-text fields a client can send, with their maximum length. Anything that
// is not a string (an object from `field[$ne]=x`, a number…) is rejected too.
export const TEXT_LIMITS = {
  notes: 5000,
  preferences: 2000,
  nextSteps: 2000,
  // After-call details (step 3): what we conveyed and the agreed look.
  conveyed: 3000,
  lookMakeup: 1000,
  lookHair: 1000,
  lookOutfit: 1000,
  skinNotes: 1000,
  caption: 200,
  location: 300,
  reason: 500,
  channel: 50,
};

// ── Reference images ────────────────────────────────────────────────────────
export const MAX_REFERENCE_IMAGES = 15;
export const MAX_REFERENCE_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB

/// Whether [incoming] more images fit beside the [existing] ones. Returns null
/// when they fit, otherwise the message to send back.
export const referenceImageRoomError = (existing, incoming) => {
  if (incoming < 1) return 'Choose at least one image';
  if (existing + incoming > MAX_REFERENCE_IMAGES) {
    const left = Math.max(MAX_REFERENCE_IMAGES - existing, 0);
    return left === 0
      ? `This call already has the maximum of ${MAX_REFERENCE_IMAGES} images`
      : `Only ${left} more ${left === 1 ? 'image fits' : 'images fit'} on this call (max ${MAX_REFERENCE_IMAGES})`;
  }
  return null;
};

/// The first text field in [body] that is not a string or is too long, as
/// { field, message }, or null when every present field is fine.
export const firstInvalidTextField = (body, limits = TEXT_LIMITS) => {
  for (const [field, max] of Object.entries(limits)) {
    const value = body?.[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') return { field, message: `${field} must be text` };
    if (value.length > max) {
      return { field, message: `${field} is too long (max ${max} characters)` };
    }
  }
  return null;
};

/// A status filter value from a query string: one of the known statuses, or
/// null. Rejects objects (`?status[$ne]=x`) so it can never become an operator.
export const parseStatusFilter = (value) =>
  typeof value === 'string' && CONSULTATION_STATUSES.includes(value) ? value : null;

// ── Access ──────────────────────────────────────────────────────────────────
// Mirrors the Flutter Access class: admin/manager have blanket access, and a
// granted PARENT key ('consultations') means every sub-section, otherwise the
// exact sub-key ('consultations.notes') must be present.
export const isFullAccessRole = (role) =>
  ['admin', 'manager'].includes(String(role ?? '').trim().toLowerCase());

export const permissionGranted = (permissions, key) => {
  const list = Array.isArray(permissions) ? permissions : [];
  const parent = String(key).split('.')[0];
  const sub = String(key).split('.')[1];
  const altParent = parent === 'consultations' ? 'stylist' : (parent === 'stylist' ? 'consultations' : null);
  if (list.includes(parent) || list.includes(key)) return true;
  if (altParent) {
    if (list.includes(altParent)) return true;
    if (sub && list.includes(`${altParent}.${sub}`)) return true;
  }
  return false;
};

/// What the signed-in user may do in the consultations module.
///  • hasModule — any consultations/stylist permission at all or stylist role.
///  • viewAll   — sees every stylist's consultations and may assign / override
///                (stylist lead: the whole module, or `consultations.reports`).
///  • Everyone else sees and acts on their OWN consultations only.
export const accessFor = (user) => {
  const permissions = Array.isArray(user?.permissions) ? user.permissions : [];
  const fullAccess = isFullAccessRole(user?.role);
  const roleKey = String(user?.role ?? '').trim().toLowerCase();
  const isStylistRole = ['stylist', 'stylist_lead', 'bridal_stylist', 'senior_stylist'].includes(roleKey);
  const hasModule =
    fullAccess ||
    isStylistRole ||
    permissions.some((p) =>
      p === 'consultations' ||
      String(p).startsWith('consultations.') ||
      p === 'stylist' ||
      String(p).startsWith('stylist.')
    );
  return {
    fullAccess,
    hasModule,
    viewAll:
      fullAccess ||
      permissionGranted(permissions, 'consultations.reports') ||
      permissionGranted(permissions, 'stylist.reports') ||
      roleKey === 'stylist_lead',
    notesPermission:
      fullAccess ||
      permissionGranted(permissions, 'consultations.notes') ||
      permissionGranted(permissions, 'stylist.notes'),
  };
};

const idStr = (v) => (v == null ? '' : String(v._id ?? v));

export const isOwnConsultation = (user, consultation) =>
  idStr(user?._id) !== '' && idStr(user?._id) === idStr(consultation?.stylistId);

/// Notes, preferences and next steps: the assigned stylist, anyone granted
/// `consultations.notes`, or full access.
export const canSeeNotes = (access, user, consultation) =>
  access.notesPermission || isOwnConsultation(user, consultation);

/// Whether the user may act on (view / edit / transition) this consultation.
export const canActOn = (access, user, consultation) =>
  access.viewAll || isOwnConsultation(user, consultation);

/// Free-text after-call fields, all guarded by the notes permission.
export const NOTE_TEXT_FIELDS = [
  'notes',
  'preferences',
  'nextSteps',
  'conveyed',
  'lookMakeup',
  'lookHair',
  'lookOutfit',
  'skinNotes',
];

// Reference images are as private as the notes.
const NOTE_FIELDS = [...NOTE_TEXT_FIELDS, 'referenceImages'];

/// Mongoose select that drops the heavy/private fields — for lists, the
/// dashboard summary and a client's call list.
export const LIGHT_SELECT = [...NOTE_FIELDS, 'history'].map((f) => `-${f}`).join(' ');

/// Plain-object copy safe to send to this user: notes fields removed unless
/// they are allowed to read them.
export const redactConsultation = (consultation, access, user) => {
  const plain =
    typeof consultation?.toObject === 'function' ? consultation.toObject() : { ...consultation };
  if (!canSeeNotes(access, user, plain)) {
    for (const f of NOTE_FIELDS) delete plain[f];
  }
  return plain;
};

// ── Validation ──────────────────────────────────────────────────────────────
/// Parse and validate a start time + duration. `scheduledAt` must be an ISO
/// string with a timezone. Returns { ok, start, end, durationMins } or
/// { ok:false, message }.
export const parseSchedule = ({ scheduledAt, durationMins }) => {
  if (typeof scheduledAt !== 'string' || !HAS_ZONE_RE.test(scheduledAt.trim())) {
    return { ok: false, message: 'scheduledAt must be an ISO date-time with a timezone' };
  }
  const start = new Date(scheduledAt.trim());
  if (Number.isNaN(start.getTime())) {
    return { ok: false, message: 'scheduledAt is not a valid date-time' };
  }
  const raw = durationMins == null || durationMins === '' ? DEFAULT_DURATION_MINS : Number(durationMins);
  if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw < MIN_DURATION_MINS || raw > MAX_DURATION_MINS) {
    return {
      ok: false,
      message: `durationMins must be a whole number between ${MIN_DURATION_MINS} and ${MAX_DURATION_MINS}`,
    };
  }
  return { ok: true, start, end: new Date(start.getTime() + raw * MINUTE_MS), durationMins: raw };
};

/// Staff paste links by hand, often without the scheme. Returns
/// { ok:true, value } ('' is allowed — the link can be added later) or
/// { ok:false, message }.
export const normalizeMeetingLink = (raw) => {
  let value = String(raw ?? '').trim();
  if (value === '') return { ok: true, value: '' };
  if (value.length > MAX_LINK_LENGTH) {
    return { ok: false, message: `Meeting link is too long (max ${MAX_LINK_LENGTH} characters)` };
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    // "meet.google.com/abc-defg-hij" → add the scheme.
    if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(value)) value = `https://${value}`;
  }
  let url;
  try {
    url = new URL(value);
  } catch (_) {
    return { ok: false, message: 'Meeting link is not a valid URL' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, message: 'Meeting link must start with http:// or https://' };
  }
  return { ok: true, value: url.toString() };
};

/// Which video platform a link belongs to; '' for an empty link.
export const detectProvider = (link) => {
  if (!link) return '';
  let host = '';
  try {
    host = new URL(link).hostname.toLowerCase();
  } catch (_) {
    return 'Other';
  }
  if (host === 'meet.google.com') return 'Google Meet';
  if (host === 'zoom.us' || host.endsWith('.zoom.us') || host.endsWith('.zoom.com')) return 'Zoom';
  return 'Other';
};

// ── Conflicts ───────────────────────────────────────────────────────────────
/// Half-open interval overlap, so back-to-back slots (10:00–10:45, 10:45–11:30)
/// do not clash.
export const intervalsOverlap = (aStart, aEnd, bStart, bEnd) =>
  new Date(aStart).getTime() < new Date(bEnd).getTime() &&
  new Date(aEnd).getTime() > new Date(bStart).getTime();

// ── History ─────────────────────────────────────────────────────────────────
export const historyEntry = ({
  action,
  status,
  user,
  reason = '',
  fromAt = null,
  toAt = null,
  fromStylistId = null,
  toStylistId = null,
  fields = [],
  overrodeConflict = false,
  at = new Date(),
}) => ({
  action,
  status,
  at,
  by: user?._id ?? null,
  byName: user?.name ?? '',
  reason: String(reason ?? '').trim(),
  fromAt,
  toAt,
  fromStylistId,
  toStylistId,
  fields,
  overrodeConflict,
});

// ── Reminders ───────────────────────────────────────────────────────────────
// Ordered earliest → latest. A reminder is sent at most once per key, recorded
// in Consultation.remindersSent.
const HOUR_MS = 60 * MINUTE_MS;
export const REMINDER_TIERS = [
  { key: '24h', ms: 24 * HOUR_MS },
  { key: '1h', ms: HOUR_MS },
];

/// The reminder that applies to a consultation starting at [scheduledAt], seen
/// from [now]: '1h' inside the last hour, '24h' inside the last day, else null
/// (too far away, or already started).
export const dueReminderKey = (scheduledAt, now = new Date()) => {
  const diff = new Date(scheduledAt).getTime() - new Date(now).getTime();
  if (!(diff > 0)) return null;
  for (let i = REMINDER_TIERS.length - 1; i >= 0; i -= 1) {
    if (diff <= REMINDER_TIERS[i].ms) return REMINDER_TIERS[i].key;
  }
  return null;
};

/// Every tier up to and including [key] — claiming a later reminder also
/// retires the earlier ones, so a missed '24h' is never sent after the '1h'.
export const tiersUpTo = (key) => {
  const idx = REMINDER_TIERS.findIndex((t) => t.key === key);
  return idx === -1 ? [] : REMINDER_TIERS.slice(0, idx + 1).map((t) => t.key);
};

/// Reminders already "spent" the moment a consultation is booked or moved:
/// someone booking a slot 3 hours away does not need a 24h reminder seconds
/// later.
export const initialRemindersSent = (scheduledAt, now = new Date()) => {
  const diff = new Date(scheduledAt).getTime() - new Date(now).getTime();
  return REMINDER_TIERS.filter((t) => diff <= t.ms).map((t) => t.key);
};

// ── Notification wording ────────────────────────────────────────────────────
const IST_OFFSET_MS = 330 * MINUTE_MS;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const istParts = (d) => {
  const ist = new Date(new Date(d).getTime() + IST_OFFSET_MS);
  return {
    day: ist.toISOString().slice(0, 10),
    date: ist.getUTCDate(),
    month: MONTHS[ist.getUTCMonth()],
    hour: ist.getUTCHours(),
    minute: ist.getUTCMinutes(),
  };
};

/// "today at 3:00 PM", "tomorrow at 11:30 AM", "on 5 Nov at 10:00 AM" (IST).
export const describeSlot = (scheduledAt, now = new Date()) => {
  const at = istParts(scheduledAt);
  const today = istParts(now).day;
  const dayMs = 86400000;
  const tomorrow = istParts(new Date(new Date(now).getTime() + dayMs)).day;
  const h12 = at.hour % 12 === 0 ? 12 : at.hour % 12;
  const time = `${h12}:${String(at.minute).padStart(2, '0')} ${at.hour >= 12 ? 'PM' : 'AM'}`;
  let when = `on ${at.date} ${at.month}`;
  if (at.day === today) when = 'today';
  else if (at.day === tomorrow) when = 'tomorrow';
  return `${when} at ${time}`;
};

/// Title + body for a consultation notification.
///  kind: assigned | rescheduled | cancelled | reassigned | reminder-24h | reminder-1h
///  ctx : { clientName, scheduledAt, actorName?, toStylistName?, isVideo?, now? }
export const buildConsultationNotice = (kind, ctx) => {
  const client = ctx.clientName || 'a client';
  const slot = describeSlot(ctx.scheduledAt, ctx.now);
  const by = ctx.actorName ? ` by ${ctx.actorName}` : '';
  switch (kind) {
    case 'assigned':
      return {
        title: 'New consultation assigned',
        body: `Consultation with ${client} ${slot}${by ? `, booked${by}` : ''}.`,
      };
    case 'rescheduled':
      return {
        title: 'Consultation rescheduled',
        body: `Consultation with ${client} is now ${slot}${by ? `, changed${by}` : ''}.`,
      };
    case 'cancelled':
      return {
        title: 'Consultation cancelled',
        body: `Consultation with ${client} (${slot}) was cancelled${by}.`,
      };
    case 'reassigned':
      return {
        title: 'Consultation reassigned',
        body: `Consultation with ${client} (${slot}) was moved${ctx.toStylistName ? ` to ${ctx.toStylistName}` : ''}${by}.`,
      };
    case 'reminder-1h':
      return {
        title: 'Consultation starting soon',
        body: `Consultation with ${client} ${slot}${ctx.isVideo ? ' (video call)' : ''}.`,
      };
    case 'reminder-24h':
      return {
        title: 'Upcoming consultation',
        body: `Consultation with ${client} ${slot}${ctx.isVideo ? ' (video call)' : ''}.`,
      };
    default:
      return { title: 'Consultation update', body: `Consultation with ${client} ${slot}.` };
  }
};

// ── Reporting (FR-13) ───────────────────────────────────────────────────────
/// SRS client statuses in the order reports list them.
export const DERIVED_STATUSES = [
  'New',
  'Contacted',
  'Consultation Scheduled',
  'Follow-up Required',
  'Appointment Confirmed',
  'Cancelled',
];

export const countByStatus = (consultations) => {
  const counts = { total: 0, Scheduled: 0, Completed: 0, Cancelled: 0, 'No-show': 0 };
  for (const c of consultations) {
    counts.total += 1;
    if (c.status in counts) counts[c.status] += 1;
  }
  return counts;
};

/// One row per stylist: how many consultations they hold, and how many ended in
/// each way. `attendedRate` is Completed ÷ (Completed + No-show) — of the
/// consultations that actually reached their time, how many the bride attended;
/// null when none have yet. Rows are ordered by completed, then total.
export const perStylistBreakdown = (consultations, names = new Map()) => {
  const rows = new Map();
  for (const c of consultations) {
    const id = idStr(c.stylistId);
    if (!rows.has(id)) {
      rows.set(id, {
        stylistId: id,
        name: names.get(id) ?? c.stylistId?.name ?? '',
        total: 0,
        scheduled: 0,
        completed: 0,
        cancelled: 0,
        noShow: 0,
      });
    }
    const row = rows.get(id);
    row.total += 1;
    if (c.status === 'Scheduled') row.scheduled += 1;
    else if (c.status === 'Completed') row.completed += 1;
    else if (c.status === 'Cancelled') row.cancelled += 1;
    else if (c.status === 'No-show') row.noShow += 1;
  }
  return [...rows.values()]
    .map((r) => ({
      ...r,
      attendedRate: r.completed + r.noShow > 0 ? r.completed / (r.completed + r.noShow) : null,
    }))
    .sort((a, b) => b.completed - a.completed || b.total - a.total || a.name.localeCompare(b.name));
};

/// Enquiries per SRS client status. [consultationsByLead] maps a lead id to ALL
/// of that lead's consultations (so the status is the same one the lead card
/// shows). Every status is present, even at 0.
export const countDerivedStatuses = (leads, consultationsByLead = new Map()) => {
  const counts = Object.fromEntries(DERIVED_STATUSES.map((s) => [s, 0]));
  for (const lead of leads) {
    const status = deriveClientStatus(lead, consultationsByLead.get(idStr(lead._id)) ?? []);
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
};

/// Scheduled consultations whose time has passed but that nobody has marked
/// completed / no-show / cancelled — the outcome still has to be recorded.
export const needingOutcome = (consultations, now = new Date()) =>
  consultations
    .filter((c) => c.status === 'Scheduled' && new Date(c.endsAt).getTime() < new Date(now).getTime())
    .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));

// ── Client status (FR-11) ───────────────────────────────────────────────────
/// The SRS client status, derived from the lead's own status and its
/// consultations so Lead.status keeps its current meaning for sales reports.
export const deriveClientStatus = (lead, consultations = []) => {
  const status = lead?.status;
  if (status === 'Lost') return 'Cancelled';
  if (status === 'Converted') return 'Appointment Confirmed';
  if (consultations.some((c) => c.status === 'Scheduled')) return 'Consultation Scheduled';

  const finished = consultations
    .filter((c) => c.status === 'Completed' || c.status === 'No-show')
    .sort((a, b) => new Date(b.scheduledAt) - new Date(a.scheduledAt));
  if (status === 'Follow-up' || status === 'Pending Lost Approval' || finished.length > 0) {
    return 'Follow-up Required';
  }
  if (status === 'Contacted' || status === 'Qualified') return 'Contacted';
  return 'New';
};
