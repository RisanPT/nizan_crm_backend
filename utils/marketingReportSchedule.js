// SCHEDULED and SAVED marketing reports — the rules (pure; tests/marketingReportSchedule.test.js). The spec's Reports screens (Team
// Dashboard, Campaigns, Lead Report) each list "Saved reports" (name, period, created by, created on, download) and "Scheduled reports"
// with an on/off switch (e.g. "Weekly Team Report — every Monday, 10:00 AM"). A scheduled report, when due, is recorded as a saved
// report for the period it covers and the marketing managers are told it is ready (services/marketingReportScheduler.js).
//
// Times are IST. A run covers the period that has just ENDED: a weekly report the week before (Monday–Sunday), a monthly report the
// month before, a quarterly report the quarter before. Each schedule runs at most once per period (`lastPeriodKey`).

import { addDays, istDayKey, istMonthBounds, istWeekStart } from './istDate.js';

export const REPORT_MODULES = ['team', 'campaigns', 'leads'];
export const CADENCES = ['weekly', 'monthly', 'quarterly'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/// The schedules the spec's Reports screens show, with their switches as drawn.
export const DEFAULT_SCHEDULES = [
  { key: 'team.weekly', module: 'team', kind: 'weekly', label: 'Weekly Team Report', cadence: 'weekly', weekday: 1, time: '10:00', enabled: true },
  { key: 'team.monthly', module: 'team', kind: 'monthly', label: 'Monthly Performance', cadence: 'monthly', dayOfMonth: 1, time: '09:00', enabled: true },
  { key: 'team.campaign-summary', module: 'team', kind: 'campaign-summary', label: 'Campaign Summary', cadence: 'weekly', weekday: 5, time: '18:00', enabled: false },
  { key: 'campaigns.weekly', module: 'campaigns', kind: 'weekly', label: 'Weekly Campaign Report', cadence: 'weekly', weekday: 1, time: '10:00', enabled: true },
  { key: 'campaigns.monthly', module: 'campaigns', kind: 'monthly', label: 'Monthly Performance Report', cadence: 'monthly', dayOfMonth: 1, time: '09:00', enabled: true },
  { key: 'campaigns.quarterly', module: 'campaigns', kind: 'quarterly', label: 'Quarterly Analysis', cadence: 'quarterly', dayOfMonth: 1, time: '09:00', enabled: false },
  { key: 'leads.weekly', module: 'leads', kind: 'weekly', label: 'Weekly Lead Report', cadence: 'weekly', weekday: 1, time: '10:00', enabled: true },
  { key: 'leads.monthly', module: 'leads', kind: 'monthly-conversion', label: 'Monthly Conversion Report', cadence: 'monthly', dayOfMonth: 1, time: '09:00', enabled: true },
  { key: 'leads.campaign-performance', module: 'leads', kind: 'campaign-performance', label: 'Campaign Performance (Monthly)', cadence: 'monthly', dayOfMonth: 1, time: '09:00', enabled: false },
];

const IST_OFFSET_MS = 330 * 60 * 1000;
/// The IST wall clock of [now]: { day: 'YYYY-MM-DD', hhmm: 'HH:mm', weekday: 0–6, dom: 1–31, month: 1–12 }.
export const istClock = (now = new Date()) => {
  const t = new Date(now.getTime() + IST_OFFSET_MS);
  return { day: t.toISOString().slice(0, 10), hhmm: t.toISOString().slice(11, 16), weekday: t.getUTCDay(), dom: t.getUTCDate(), month: t.getUTCMonth() + 1 };
};

const short = (d) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;

/// The period a run on [day] covers. → { from, to, key, label }
export const periodFor = (cadence, day) => {
  if (cadence === 'weekly') {
    const from = addDays(istWeekStart(day), -7);
    const to = addDays(from, 6);
    return { from, to, key: `w:${from}`, label: `${short(from)} – ${short(to)} ${to.slice(0, 4)}` };
  }
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  if (cadence === 'monthly') {
    const py = m === 1 ? y - 1 : y;
    const pm = m === 1 ? 12 : m - 1;
    const b = istMonthBounds(py, pm);
    return { from: b.from, to: b.to, key: `m:${b.from.slice(0, 7)}`, label: `${MONTHS[pm - 1]} ${py}` };
  }
  // quarterly: the quarter before the one [day] is in
  const q = Math.floor((m - 1) / 3); // 0..3
  const pq = q === 0 ? 3 : q - 1;
  const py = q === 0 ? y - 1 : y;
  const from = istMonthBounds(py, pq * 3 + 1).from;
  const to = istMonthBounds(py, pq * 3 + 3).to;
  return { from, to, key: `q:${py}-${pq + 1}`, label: `Q${pq + 1} ${py}` };
};

/// Is today a run day for [s]? (weekly: its weekday; monthly: its day of the month — the last day when the month is shorter; quarterly:
/// that day in Jan / Apr / Jul / Oct)
const isRunDay = (s, clock) => {
  if (s.cadence === 'weekly') return clock.weekday === Number(s.weekday);
  const lastDom = Number(istMonthBounds(Number(clock.day.slice(0, 4)), clock.month).to.slice(8, 10));
  const dom = Math.min(Number(s.dayOfMonth) || 1, lastDom);
  if (clock.dom !== dom) return false;
  return s.cadence === 'monthly' || [1, 4, 7, 10].includes(clock.month);
};

/**
 * Is [s] due at [now]? A switched-on schedule is due on its run day from its time onwards (a server that was down at 10:00 still
 * runs it later that day), once per period. → the period to run, or null.
 */
export const dueRun = (s, now = new Date()) => {
  if (!s?.enabled || !CADENCES.includes(s.cadence)) return null;
  const clock = istClock(now);
  if (!isRunDay(s, clock) || clock.hhmm < String(s.time || '00:00')) return null;
  const period = periodFor(s.cadence, clock.day);
  return s.lastPeriodKey === period.key ? null : period;
};

const ampm = (hhmm) => {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
const ordinal = (n) => `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

/// "Every Monday, 10:00 AM" · "1st of every month, 9:00 AM" · "1st Jan, Apr, Jul, Oct, 9:00 AM"
export const describeSchedule = (s) => {
  if (s.cadence === 'weekly') return `Every ${WEEKDAYS[Number(s.weekday) || 0]}, ${ampm(s.time)}`;
  const d = ordinal(Number(s.dayOfMonth) || 1);
  if (s.cadence === 'monthly') return `${d} of every month, ${ampm(s.time)}`;
  return `${d} Jan, Apr, Jul, Oct, ${ampm(s.time)}`;
};

/// The next time [s] runs after [now] (IST day + time), for "Next run". Null when switched off.
export const nextRun = (s, now = new Date()) => {
  if (!s?.enabled) return null;
  const clock = istClock(now);
  for (let i = 0; i < 400; i += 1) {
    const day = addDays(clock.day, i);
    const d = new Date(`${day}T${s.time || '00:00'}:00+05:30`);
    const c = istClock(d);
    if (!isRunDay(s, c)) continue;
    if (d <= now) continue;
    return d;
  }
  return null;
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/// A manager's change to a schedule: { enabled, time 'HH:mm', weekday 0–6 (weekly), dayOfMonth 1–28 (monthly/quarterly) }.
/// → { set } or { error }
export const cleanScheduleUpdate = (body = {}, s = {}) => {
  const set = {};
  if ('enabled' in body) set.enabled = body.enabled === true;
  if ('time' in body) {
    if (!TIME_RE.test(String(body.time))) return { error: 'time must be HH:mm (24-hour).' };
    set.time = String(body.time);
  }
  if ('weekday' in body) {
    if (s.cadence !== 'weekly') return { error: 'Only a weekly report has a weekday.' };
    const w = Number(body.weekday);
    if (!Number.isInteger(w) || w < 0 || w > 6) return { error: 'weekday must be 0 (Sunday) to 6 (Saturday).' };
    set.weekday = w;
  }
  if ('dayOfMonth' in body) {
    if (s.cadence === 'weekly') return { error: 'A weekly report has no day of the month.' };
    const d = Number(body.dayOfMonth);
    if (!Number.isInteger(d) || d < 1 || d > 28) return { error: 'dayOfMonth must be 1 to 28.' };
    set.dayOfMonth = d;
  }
  return { set };
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/// A report someone generated, to keep in "Saved reports". → { doc } or { error }
export const cleanSavedReport = (body = {}) => {
  const module = String(body.module ?? '').trim();
  if (!REPORT_MODULES.includes(module)) return { error: `module must be one of ${REPORT_MODULES.join(', ')}.` };
  const kind = String(body.kind ?? '').trim().slice(0, 60);
  if (!kind) return { error: 'Say which report it is (kind).' };
  const name = String(body.name ?? '').trim().slice(0, 140) || kind;
  const from = String(body.from ?? '').trim();
  const to = String(body.to ?? '').trim();
  if (!DAY_RE.test(from) || !DAY_RE.test(to) || to < from) return { error: 'from and to must be days (YYYY-MM-DD), from first.' };
  const brand = ['main', 'kerala'].includes(String(body.brand ?? '').toLowerCase()) ? String(body.brand).toLowerCase() : 'all';
  return { doc: { module, kind, name, from, to, brand } };
};

export { istDayKey };
