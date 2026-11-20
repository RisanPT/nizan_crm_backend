// Speed to lead — how long a lead that came in on its own (a Meta Lead Ads form, the website's enquiry form) waits for its first
// contact (pure — tests/leadResponse.test.js). The service (services/leadResponse.js) loads the leads and their first logged activity;
// the Lead Report's "Speed to lead" tab and the "a new lead is waiting" alert both read these rules, so they always agree.
//
//  • First contact = the earliest of: the first call / WhatsApp / follow-up / activity logged on the lead (LeadActivity), and the first
//    time the lead was moved out of New (Lead.firstContactAt, stamped by the server since this was added).
//  • Waiting is counted in WORKING minutes (a daily window in IST, 09:00–21:00 unless set otherwise): a form filled at 11 pm and called
//    at 9:10 am waited 10 minutes, not 10 hours.
//  • A lead moved on (Qualified, Lost…) with nothing logged and no stamp is "not recorded" — never a guessed time, never a false 0.

export const AUTO_ORIGINS = ['meta_lead_ads', 'website', 'whatsapp'];
export const META_LEAD_BY = 'Meta Lead Ads';
export const DEFAULT_RESPONSE_SETTINGS = { targetMinutes: 15, alertAfterMinutes: 30, dayStart: '09:00', dayEnd: '21:00', alertsOn: true };

const IST = 330 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutesOf = (hhmm) => {
  const m = HHMM.exec(String(hhmm ?? ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** A lead that came in on its own (no one typed it): a form, the website — or, before `origin` existed, a Meta Lead Ads lead. */
export const isAutoLead = (l) => AUTO_ORIGINS.includes(l?.origin) || l?.createdByName === META_LEAD_BY;

/** Minutes between two instants that fall inside the daily working window (IST). A window that makes no sense counts every minute. */
export const businessMinutes = (from, to, { dayStart = DEFAULT_RESPONSE_SETTINGS.dayStart, dayEnd = DEFAULT_RESPONSE_SETTINGS.dayEnd } = {}) => {
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  const s = minutesOf(dayStart);
  const e = minutesOf(dayEnd);
  if (s == null || e == null || e <= s) return Math.round((b - a) / 60000);
  let total = 0;
  // IST midnight (as an instant) of the day [a] falls on, then day by day (a year at most)
  let midnight = Math.floor((a + IST) / DAY) * DAY - IST;
  for (let i = 0; midnight < b && i < 400; i += 1, midnight += DAY) {
    const lo = Math.max(a, midnight + s * 60000);
    const hi = Math.min(b, midnight + e * 60000);
    if (hi > lo) total += hi - lo;
  }
  return Math.round(total / 60000);
};

/** The settings as saved, checked: { ok, value } or { ok: false, message, field }. Only what was sent changes. */
export const cleanResponseSettings = (b = {}, current = DEFAULT_RESPONSE_SETTINGS) => {
  const out = { ...DEFAULT_RESPONSE_SETTINGS, ...current };
  const fail = (message, field) => ({ ok: false, message, field });
  const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : NaN);
  if (b.targetMinutes !== undefined) {
    out.targetMinutes = int(b.targetMinutes);
    if (!(out.targetMinutes >= 1 && out.targetMinutes <= 1440)) return fail('The target must be between 1 minute and 24 hours.', 'targetMinutes');
  }
  if (b.alertAfterMinutes !== undefined) {
    out.alertAfterMinutes = int(b.alertAfterMinutes);
    if (!(out.alertAfterMinutes >= 1 && out.alertAfterMinutes <= 2880)) return fail('The alert must come between 1 minute and 48 hours.', 'alertAfterMinutes');
  }
  if (b.dayStart !== undefined) out.dayStart = String(b.dayStart);
  if (b.dayEnd !== undefined) out.dayEnd = String(b.dayEnd);
  if (minutesOf(out.dayStart) == null || minutesOf(out.dayEnd) == null) return fail('Working hours are HH:MM, like 09:00.', 'dayStart');
  if (minutesOf(out.dayEnd) <= minutesOf(out.dayStart)) return fail('Working hours must end after they start.', 'dayEnd');
  if (b.alertsOn !== undefined) out.alertsOn = b.alertsOn === true;
  return { ok: true, value: { targetMinutes: out.targetMinutes, alertAfterMinutes: out.alertAfterMinutes, dayStart: out.dayStart, dayEnd: out.dayEnd, alertsOn: out.alertsOn } };
};

const at = (v) => (v ? new Date(v) : null);

/**
 * One lead's response: { state: 'contacted' | 'waiting' | 'unrecorded', minutes (working minutes to first contact), waitingMinutes
 * (still waiting), within (inside the target), firstAt, firstBy, firstVia }. [firstActivity] = { at, byName, via } of the first
 * LeadActivity logged on it (or null).
 */
export const responseOf = (lead, firstActivity, now, settings = DEFAULT_RESPONSE_SETTINGS) => {
  const arrived = at(lead.createdAt) ?? now;
  const stamped = lead.firstContactAt ? { at: at(lead.firstContactAt), byName: lead.firstContactByName ?? '', via: lead.firstContactVia ?? '' } : null;
  const act = firstActivity?.at ? { ...firstActivity, at: at(firstActivity.at) } : null;
  const first = [stamped, act].filter(Boolean).sort((x, y) => x.at - y.at)[0] ?? null;
  if (first) {
    const minutes = businessMinutes(arrived, first.at, settings);
    return { state: 'contacted', minutes, waitingMinutes: null, within: minutes <= settings.targetMinutes, firstAt: first.at, firstBy: first.byName, firstVia: first.via };
  }
  if (lead.status === 'New') {
    return { state: 'waiting', minutes: null, waitingMinutes: businessMinutes(arrived, now, settings), within: null, firstAt: null, firstBy: '', firstVia: '' };
  }
  return { state: 'unrecorded', minutes: null, waitingMinutes: null, within: null, firstAt: null, firstBy: '', firstVia: '' };
};

export const median = (xs) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/** The figures of a set of leads' responses: how many came, were contacted, the median wait, the share inside the target, waiting now. */
export const responseStats = (rows, settings = DEFAULT_RESPONSE_SETTINGS) => {
  const contacted = rows.filter((r) => r.state === 'contacted');
  const waiting = rows.filter((r) => r.state === 'waiting');
  return {
    leads: rows.length,
    contacted: contacted.length,
    medianMinutes: median(contacted.map((r) => r.minutes)),
    withinPct: contacted.length ? Math.round((contacted.filter((r) => r.within).length / contacted.length) * 100) : null,
    waiting: waiting.length,
    // waiting longer than the target already
    late: waiting.filter((r) => r.waitingMinutes > settings.targetMinutes).length,
    unrecorded: rows.filter((r) => r.state === 'unrecorded').length,
  };
};

/** [rows] cut by [keyOf] (a person, a source) → [{ key, ...responseStats }], the most leads first. */
export const responseGroups = (rows, keyOf, settings = DEFAULT_RESPONSE_SETTINGS) => {
  const m = new Map();
  for (const r of rows) {
    const k = keyOf(r) || '—';
    m.set(k, [...(m.get(k) ?? []), r]);
  }
  return [...m.entries()].map(([key, list]) => ({ key, ...responseStats(list, settings) })).sort((a, b) => b.leads - a.leads || String(a.key).localeCompare(String(b.key)));
};

/** Should the "a new lead is waiting" alert go out for this lead now? Only for a lead that came in on its own, still New, not yet alerted. */
export const shouldAlert = (lead, firstActivity, now, settings = DEFAULT_RESPONSE_SETTINGS) => {
  if (!settings.alertsOn || !isAutoLead(lead) || lead.responseAlertAt) return false;
  const r = responseOf(lead, firstActivity, now, settings);
  return r.state === 'waiting' && r.waitingMinutes >= settings.alertAfterMinutes;
};
