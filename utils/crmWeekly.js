// THE CRM WEEKLY REPORT's figures — the eight items of the CRM team's weekly format, worked out from the records. Pure; the loading is in
// services/crmWeekly.js. tests/crmWeekly.test.js. A week runs Monday to Sunday (IST days 'YYYY-MM-DD').
//
//   1 Trials          held in the week (not cancelled), completed, cancelled, postponed, and how many became bookings (utils/crmStats.js).
//   2 Photos/reviews  the week's WORKS DONE (a work = a booking on one of its days, days up to today) — with photos collected (the CRM's
//                     tick per work day), and of the CLIENTS done, how many have answered the review form.
//   3 Support         how many different clients the CRM handled: answered in the chat, had a booking request decided, or a case
//                     worked (a call, WhatsApp or note). The month so far against the monthly target.
//   4 Starting msgs   typed in the report (Nizan and Team N counts).
//   5 Verification    the coming week's works: how many the CRM verified with the client (the "verified" tick per work day). And the
//                     week's own works verified beforehand.
//   6 Medical         the week's and the coming week's works whose client has a medical condition, and the emergencies logged.
//   7 Workload        the coming week, day by day: bookings against the day's slot capacity (the same rule as the Slots screen: one per
//                     booking on its booking date; the HR capacity of the day, else the default; a blocked day takes none).
//   8 Outsource       the week's works done by outside (associate) artists: bride, artist, work, phone — and how many each did.
//
// Figures that rest on the CRM's own ticks (photos, verification, medical) are null — "—" — for a week that ended before the ticks began.

import { addDays, istDayKey, istWeekStart, isDay } from './istDate.js';
import { hasMark, worksBetween, MEDICAL_LABEL } from './crmCare.js';
import { normalizePhone } from './phone.js';

const idOf = (v) => (v == null ? '' : String(v._id ?? v));
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const short = (day) => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;

/// The week (Monday–Sunday) that [day] falls in: { from, to, label }. [day] defaults to the week before [today] (the one being reported).
export const weekOf = (day) => {
  const from = istWeekStart(day);
  const to = addDays(from, 6);
  return { from, to, label: `${short(from)} – ${short(to)} ${to.slice(0, 4)}` };
};

/// The week asked for (?week=any day in it), else the last full week before [today].
export const resolveWeek = (asked, today) => {
  const a = String(asked ?? '').trim();
  if (a) {
    if (!isDay(a)) return { error: 'week must be a day (YYYY-MM-DD).' };
    return weekOf(a);
  }
  return weekOf(addDays(istWeekStart(today), -7));
};

export const nextWeekOf = (week) => weekOf(addDays(week.from, 7));
export const previousWeekOf = (week) => weekOf(addDays(week.from, -7));

const workRef = ({ booking, day }) => ({
  bookingId: idOf(booking),
  bookingNumber: booking.bookingNumber ?? '',
  client: booking.customerName ?? '',
  phone: booking.phone ?? '',
  day,
});

// ── 2 photos & reviews ──────────────────────────────────────────────────────

/**
 * [bookings] with days in the week; [careOf](bookingId) → its care record; [reviewed] the set of booking ids with an answered review.
 * Works up to [today] count as done.
 */
export const photosReviewsFigures = ({ bookings, careOf, reviewed, week, today, tracked = true }) => {
  const done = worksBetween(bookings, week.from, week.to < today ? week.to : today);
  const withPhotos = done.filter((w) => hasMark(careOf(idOf(w.booking))?.photos, w.day));
  const clients = [...new Map(done.map((w) => [idOf(w.booking), w])).values()];
  const withReview = clients.filter((w) => reviewed.has(idOf(w.booking)));
  return {
    worksDone: done.length,
    photos: tracked ? withPhotos.length : null,
    photosPct: tracked ? pct(withPhotos.length, done.length) : null,
    clientsDone: clients.length,
    reviews: withReview.length,
    reviewsPct: pct(withReview.length, clients.length),
    missingPhotos: tracked ? done.filter((w) => !hasMark(careOf(idOf(w.booking))?.photos, w.day)).map(workRef) : [],
    missingReviews: clients.filter((w) => !reviewed.has(idOf(w.booking))).map(workRef),
  };
};

// ── 3 customer support ──────────────────────────────────────────────────────

/**
 * [events]: { client (a key: the client's phone, else a chat id), by (user id), byName } — one per thing the CRM did for a client.
 * → { clients, byMember: [{ name, clients }] } (busiest first).
 */
export const supportFigures = (events) => {
  const all = new Set();
  const people = new Map();
  for (const e of events) {
    if (!e?.client) continue;
    all.add(e.client);
    const key = idOf(e.by) || `name:${e.byName || ''}`;
    const p = people.get(key) ?? { name: e.byName || 'Someone', clients: new Set() };
    if (!p.name || p.name === 'Someone') p.name = e.byName || p.name;
    p.clients.add(e.client);
    people.set(key, p);
  }
  return {
    clients: all.size,
    byMember: [...people.values()].map((p) => ({ name: p.name, clients: p.clients.size })).sort((a, b) => b.clients - a.clients || a.name.localeCompare(b.name)),
  };
};

/// A client's key for counting: the last 10 digits of the phone, else the given fallback (a chat's id).
export const clientKey = (phone, fallback = '') => {
  const p = normalizePhone(phone);
  return p.length >= 6 ? `p:${p}` : fallback ? `x:${fallback}` : '';
};

// ── 5 verification ──────────────────────────────────────────────────────────

/// The works in [range] and how many were verified with the client. → { from, to, works, verified, pct, unverified[] }
export const verificationFigures = ({ bookings, careOf, range, tracked = true }) => {
  const works = worksBetween(bookings, range.from, range.to);
  const verified = works.filter((w) => hasMark(careOf(idOf(w.booking))?.verifications, w.day));
  return {
    from: range.from,
    to: range.to,
    works: works.length,
    verified: tracked ? verified.length : null,
    pct: tracked ? pct(verified.length, works.length) : null,
    unverified: tracked ? works.filter((w) => !hasMark(careOf(idOf(w.booking))?.verifications, w.day)).map(workRef) : [],
  };
};

// ── 6 medical ───────────────────────────────────────────────────────────────

/**
 * The works in [range] whose client has a medical condition (one line per booking, its days in the range), and the emergencies logged
 * for a day in [week].
 */
export const medicalFigures = ({ bookings, careOf, range, week, tracked = true }) => {
  if (!tracked) return { withConditions: null, emergencies: null };
  const byBooking = new Map();
  for (const w of worksBetween(bookings, range.from, range.to)) {
    const care = careOf(idOf(w.booking));
    if (!care?.medical?.conditions?.length) continue;
    const row = byBooking.get(idOf(w.booking)) ?? {
      ...workRef(w),
      days: [],
      conditions: care.medical.conditions.map((c) => MEDICAL_LABEL[c] ?? c),
      note: care.medical.note ?? '',
    };
    row.days.push(w.day);
    byBooking.set(idOf(w.booking), row);
  }
  const emergencies = [];
  for (const b of bookings) {
    for (const e of careOf(idOf(b))?.emergencies ?? []) {
      if (e.day >= week.from && e.day <= week.to) {
        emergencies.push({ bookingId: idOf(b), bookingNumber: b.bookingNumber ?? '', client: b.customerName ?? '', day: e.day, what: e.what, action: e.action ?? '', byName: e.byName ?? '', at: e.at });
      }
    }
  }
  return {
    withConditions: [...byBooking.values()].sort((a, b) => a.days[0].localeCompare(b.days[0])),
    emergencies: emergencies.sort((a, b) => a.day.localeCompare(b.day)),
  };
};

// ── 7 workload ──────────────────────────────────────────────────────────────

/**
 * Day by day over [range]: [bookedOn](day) bookings against [capacityOn](day) → { days: [{ day, booked, capacity, blocked, over }],
 * booked, capacity, overDays }. A blocked day has no capacity.
 */
export const workloadFigures = ({ range, bookedOn, capacityOn, blockedOn = () => false }) => {
  const days = [];
  for (let d = range.from; d <= range.to; d = addDays(d, 1)) {
    const blocked = blockedOn(d);
    const capacity = blocked ? 0 : capacityOn(d);
    const booked = bookedOn(d);
    days.push({ day: d, booked, capacity, blocked, over: booked > capacity, spare: Math.max(0, capacity - booked) });
  }
  return {
    from: range.from,
    to: range.to,
    days,
    booked: days.reduce((a, x) => a + x.booked, 0),
    capacity: days.reduce((a, x) => a + x.capacity, 0),
    overDays: days.filter((x) => x.over).length,
    busiest: days.reduce((m, x) => (x.booked > (m?.booked ?? -1) ? x : m), null),
  };
};

// ── 8 outsource ─────────────────────────────────────────────────────────────

/// The Associate Works rows of the week (utils/associateWorks.js workRows) → the report's lines and a count per artist.
export const outsourceFigures = (rows) => {
  const lines = rows
    .map((r) => ({
      bride: r.customerName,
      outsource: r.associateName,
      work: [r.services.join(', '), r.role].filter(Boolean).join(' · '),
      phone: r.phone,
      day: r.firstDay,
      days: r.days,
      bookingNumber: r.bookingNumber,
    }))
    .sort((a, b) => a.day.localeCompare(b.day) || a.bride.localeCompare(b.bride));
  const people = new Map();
  for (const l of lines) {
    const p = people.get(l.outsource) ?? { name: l.outsource, phone: l.phone, works: 0 };
    p.works += 1;
    people.set(l.outsource, p);
  }
  return { lines, total: lines.length, byPerson: [...people.values()].sort((a, b) => b.works - a.works || a.name.localeCompare(b.name)) };
};

// ── 4 & 7: what the CRM Head types ──────────────────────────────────────────

const count = (v, name) => {
  if (v === undefined || v === null || v === '') return { value: null };
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 100000) return { error: `${name} must be a whole number (0 or more).` };
  return { value: n };
};

/**
 * The typed part of the report, as sent (only the fields sent change). → { set } or { error }.
 *   startingMessagesNizan, startingMessagesTeamN (counts), startingMessagesNote, manpowerPlan, enoughWork ('yes'|'no'|''),
 *   enoughWorkNote, notes,
 *   overrides { <OVERRIDE_FIELDS key>: count | null } — a figure typed by hand (null goes back to the records'); only the keys sent change,
 *   sectionNotes { <WEEKLY_SECTIONS>: text } — why / where from; only the sections sent change,
 *   outsourceLines [{ bride, outsource, work, phone, day }] — outside-artist works the records do not have (the whole list is replaced).
 */
export const cleanTyped = (body = {}) => {
  const set = {};
  for (const [k, label] of [['startingMessagesNizan', 'Nizan starting messages'], ['startingMessagesTeamN', 'Team N starting messages']]) {
    if (!(k in body)) continue;
    const r = count(body[k], label);
    if (r.error) return { error: r.error };
    set[k] = r.value;
  }
  for (const [k, max] of [['startingMessagesNote', 1000], ['manpowerPlan', 2000], ['enoughWorkNote', 1000], ['notes', 4000]]) {
    if (k in body) set[k] = String(body[k] ?? '').trim().slice(0, max);
  }
  if ('enoughWork' in body) {
    const v = String(body.enoughWork ?? '').trim().toLowerCase();
    if (!['', 'yes', 'no'].includes(v)) return { error: 'enoughWork must be yes or no.' };
    set.enoughWork = v;
  }
  if ('overrides' in body) {
    const o = body.overrides;
    if (o == null || typeof o !== 'object' || Array.isArray(o)) return { error: 'overrides must be the figures typed by hand.' };
    const ov = {};
    for (const [k, v] of Object.entries(o)) {
      const field = FIELD_BY_KEY.get(k);
      if (!field) return { error: `${k} is not a figure of the weekly report.` };
      const r = count(v, field.label);
      if (r.error) return { error: r.error };
      ov[k] = r.value;
    }
    set.overrides = ov;
  }
  if ('sectionNotes' in body) {
    const o = body.sectionNotes;
    if (o == null || typeof o !== 'object' || Array.isArray(o)) return { error: 'sectionNotes must be a note per item.' };
    const notes = {};
    for (const [k, v] of Object.entries(o)) {
      if (!WEEKLY_SECTIONS.includes(k)) return { error: `${k} is not an item of the weekly report.` };
      notes[k] = String(v ?? '').trim().slice(0, 500);
    }
    set.sectionNotes = notes;
  }
  if ('outsourceLines' in body) {
    const list = body.outsourceLines ?? [];
    if (!Array.isArray(list)) return { error: 'outsourceLines must be a list.' };
    if (list.length > 100) return { error: 'At most 100 outsource lines can be typed in.' };
    const lines = [];
    for (const [i, l] of list.entries()) {
      const text = (k, max) => String(l?.[k] ?? '').trim().slice(0, max);
      const line = { bride: text('bride', 120), outsource: text('outsource', 120), work: text('work', 200), phone: text('phone', 20), day: text('day', 10) };
      if (!line.bride || !line.outsource) return { error: `Outsource line ${i + 1}: give the bride's name and the outside artist's name.` };
      if (line.day && !isDay(line.day)) return { error: `Outsource line ${i + 1}: the day must be YYYY-MM-DD.` };
      lines.push(line);
    }
    set.outsourceLines = lines;
  }
  return { set };
};

/// The update for the cleaned [set]: a figure or a section note typed by hand changes on its own (the others stay); the rest replace.
export const typedSetPaths = (set) => {
  const out = {};
  for (const [k, v] of Object.entries(set)) {
    if (k === 'overrides' || k === 'sectionNotes') for (const [kk, vv] of Object.entries(v)) out[`typed.${k}.${kk}`] = vv;
    else out[`typed.${k}`] = v;
  }
  return out;
};

// ── figures typed by hand ───────────────────────────────────────────────────
//
// The CRM Head can type any of these in place of the records' figure — when the records missed something (a trial kept on paper, photos
// collected on WhatsApp). The report then shows the typed figure (marked so), with the records' one beside it; the PDF and Excel the same.

export const WEEKLY_SECTIONS = ['trials', 'photos', 'support', 'verification', 'medical', 'workload', 'outsource'];

export const OVERRIDE_FIELDS = [
  { key: 'trialsHeld', section: 'trials', label: 'Trials held', path: ['trials', 'held'] },
  { key: 'trialsCompleted', section: 'trials', label: 'Trials completed', path: ['trials', 'completed'] },
  { key: 'trialsConverted', section: 'trials', label: 'Trials that became bookings', path: ['trials', 'converted'] },
  { key: 'worksDone', section: 'photos', label: 'Makeover works done', path: ['photosReviews', 'worksDone'] },
  { key: 'photos', section: 'photos', label: 'Photos collected', path: ['photosReviews', 'photos'] },
  { key: 'clientsDone', section: 'photos', label: 'Clients done', path: ['photosReviews', 'clientsDone'] },
  { key: 'reviews', section: 'photos', label: 'Reviews collected', path: ['photosReviews', 'reviews'] },
  { key: 'supportClients', section: 'support', label: 'Clients handled this week', path: ['support', 'clients'] },
  { key: 'monthToDate', section: 'support', label: 'Clients handled this month', path: ['support', 'monthToDate'] },
  { key: 'verifyWorks', section: 'verification', label: "Coming week's works", path: ['verification', 'nextWeek', 'works'] },
  { key: 'verified', section: 'verification', label: "Coming week's works verified", path: ['verification', 'nextWeek', 'verified'] },
  { key: 'medicalConditions', section: 'medical', label: 'Clients with a medical condition', path: ['medical', 'conditionsCount'] },
  { key: 'medicalEmergencies', section: 'medical', label: 'Medical emergencies', path: ['medical', 'emergenciesCount'] },
  { key: 'workloadBooked', section: 'workload', label: 'Coming week: bookings', path: ['workload', 'nextWeek', 'booked'] },
  { key: 'workloadCapacity', section: 'workload', label: 'Coming week: slots', path: ['workload', 'nextWeek', 'capacity'] },
];
const FIELD_BY_KEY = new Map(OVERRIDE_FIELDS.map((f) => [f.key, f]));

const at = (obj, path) => path.reduce((o, k) => (o == null ? undefined : o[k]), obj);
const put = (obj, path, v) => {
  let o = obj;
  for (const k of path.slice(0, -1)) {
    if (o[k] == null || typeof o[k] !== 'object') o[k] = {};
    o = o[k];
  }
  o[path[path.length - 1]] = v;
};
const typedOf = (typed) => Object.fromEntries(Object.entries(typed?.overrides ?? {}).filter(([k, v]) => FIELD_BY_KEY.has(k) && v != null));

/**
 * The report's figures with what the Head typed by hand put in: [figures] as the records have them (fresh, or the snapshot handed in),
 * [typed] the report's typed part. → { figures (a copy, with the typed figures, the percentages that follow from them and the
 * outsource lines typed in), records: { <key>: the records' figure } for every figure that can be typed, typedKeys }.
 */
export const effectiveFigures = (figures, typed = {}) => {
  const f = JSON.parse(JSON.stringify(figures ?? {}));
  f.medical = {
    ...(f.medical ?? {}),
    conditionsCount: Array.isArray(f.medical?.withConditions) ? f.medical.withConditions.length : null,
    emergenciesCount: Array.isArray(f.medical?.emergencies) ? f.medical.emergencies.length : null,
  };
  const records = Object.fromEntries(OVERRIDE_FIELDS.map((x) => [x.key, at(f, x.path) ?? null]));

  // outside-artist works typed in, after the records' own
  const extra = (typed?.outsourceLines ?? []).map((l) => ({
    bride: l.bride ?? '',
    outsource: l.outsource ?? '',
    work: l.work ?? '',
    phone: l.phone ?? '',
    day: l.day ?? '',
    days: l.day ? [l.day] : [],
    bookingNumber: '',
    byHand: true,
  }));
  if (extra.length) {
    const lines = [...(f.outsource?.lines ?? []), ...extra];
    const people = new Map();
    for (const l of lines) {
      const p = people.get(l.outsource) ?? { name: l.outsource, phone: l.phone, works: 0 };
      p.works += 1;
      people.set(l.outsource, p);
    }
    f.outsource = { ...(f.outsource ?? {}), lines, total: lines.length, byPerson: [...people.values()].sort((a, b) => b.works - a.works || a.name.localeCompare(b.name)) };
  }

  const typedNow = typedOf(typed);
  for (const [k, v] of Object.entries(typedNow)) put(f, FIELD_BY_KEY.get(k).path, v);

  // the percentages follow the figures shown
  const p = f.photosReviews;
  if (p) {
    p.photosPct = p.photos == null ? null : pct(p.photos, p.worksDone);
    p.reviewsPct = pct(p.reviews, p.clientsDone);
  }
  const vn = f.verification?.nextWeek;
  if (vn) vn.pct = vn.verified == null ? null : pct(vn.verified, vn.works);
  if (f.trials && ['trialsCompleted', 'trialsConverted'].some((k) => k in typedNow)) f.trials.conversionPct = pct(f.trials.converted, f.trials.completed);
  return { figures: f, records, typedKeys: Object.keys(typedNow) };
};

/// What does not add up once figures are typed by hand (a part bigger than its whole) — only where one side was typed. → messages
export const overrideProblems = (figures, typedKeys = []) => {
  const typedSet = new Set(typedKeys);
  const out = [];
  const pairs = [
    ['trialsCompleted', 'trialsHeld'],
    ['trialsConverted', 'trialsHeld'],
    ['photos', 'worksDone'],
    ['clientsDone', 'worksDone'],
    ['reviews', 'clientsDone'],
    ['verified', 'verifyWorks'],
  ];
  for (const [part, whole] of pairs) {
    if (!typedSet.has(part) && !typedSet.has(whole)) continue;
    const a = at(figures, FIELD_BY_KEY.get(part).path);
    const b = at(figures, FIELD_BY_KEY.get(whole).path);
    if (a != null && b != null && a > b) out.push(`${FIELD_BY_KEY.get(part).label} (${a}) can't be more than ${FIELD_BY_KEY.get(whole).label.toLowerCase()} (${b}) — type that too.`);
  }
  return out;
};

/// Is the report ready to submit? The two counts and the manpower answers are needed. → a list of what is missing.
export const missingForSubmit = (typed = {}) => {
  const missing = [];
  if (typed.startingMessagesNizan == null) missing.push('Nizan starting messages');
  if (typed.startingMessagesTeamN == null) missing.push('Team N starting messages');
  if (!String(typed.manpowerPlan ?? '').trim()) missing.push('the plan for extra manpower');
  if (!typed.enoughWork) missing.push('whether there is enough work');
  return missing;
};

/// Today's IST day (for tests to pass their own).
export const todayOf = (now = new Date()) => istDayKey(now);
