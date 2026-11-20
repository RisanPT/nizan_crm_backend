// The Marketing team's attendance from Timebox — the company's own attendance software — EXACTLY as Timebox has it: who punched in, when
// they came and left, the hours Timebox counted, each month's days present and attendance %, and the day's Timebox plan (worklist).
//
//  • A member is linked through their login → its employee → that employee's Timebox id (kept in step by the Timebox employee sync);
//    a member with no login linked is matched to the ONE employee with the same name (two with that name are not guessed). An unlinked
//    member is listed so the Marketing Manager can link their login in EOD → Setup.
//  • LIVE Timebox only. When the server has no Timebox address (TIMEBOX_API_URL) the client serves its bundled demo export — that is
//    exactly the "fake data" the team must never see — so here demo mode counts as "Timebox not connected" and nothing from it is used.
//  • Reads are cached for a minute (the dashboard asks for the same days from several cards); a failure is said in plain words and the
//    screens fall back to the CRM's own records, labelled as such.
import mongoose from 'mongoose';
import Employee from '../models/Employee.js';
import User from '../models/User.js';
import { timeboxFetch, timeboxMode } from './timeboxClient.js';

const CACHE_MS = 60 * 1000;
const FAIL_CACHE_MS = 15 * 1000;
const idOf = (v) => (v == null ? '' : String(v._id ?? v));
const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const TIMEBOX_NOT_CONNECTED = 'Timebox is not connected on this server (TIMEBOX_API_URL is not set), so attendance comes from the CRM\'s own records and the work logs.';

// ── reading Timebox (cached, live only) ──────────────────────────────────────

const cache = new Map(); // key → { until, promise }
export const _resetMarketingTimeboxCache = () => cache.clear();

const read = (resource, params) => {
  const key = `${resource}|${params.from ?? ''}|${params.to ?? ''}`;
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.promise;
  const promise = timeboxFetch(resource, params).then((r) => {
    if (r?.source !== 'live') throw new Error('not live');
    return Array.isArray(r.data) ? r.data : [];
  });
  cache.set(key, { until: Date.now() + CACHE_MS, promise });
  promise.catch(() => cache.set(key, { until: Date.now() + FAIL_CACHE_MS, promise }));
  return promise;
};

const plainProblem = (err) => {
  const m = String(err?.message ?? '');
  if (/API key/i.test(m)) return 'Timebox refused the CRM\'s key (TIMEBOX_API_KEY). Attendance below comes from the CRM\'s own records.';
  if (/HTTP \d+/.test(m)) return `Timebox answered with an error (${m.match(/HTTP \d+/)[0]}). Attendance below comes from the CRM's own records.`;
  return 'Timebox could not be reached just now. Attendance below comes from the CRM\'s own records.';
};

const tbIdOf = (row) => {
  const n = Number(row?.employee?.id ?? row?.employee_id ?? row?.id);
  return Number.isFinite(n) ? n : null;
};
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const time = (v) => {
  if (!v || v === 'None') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const yes = (v) => v === true || String(v).toLowerCase() === 'true';

/** One Timebox day of one person, as the screens use it. */
export const dayRecord = (r) => {
  const loginAt = time(r.login_time);
  const logoutAt = time(r.logout_time);
  const worked = num(r.worked_minutes) ?? (num(r.worked_hours) != null ? Math.round(num(r.worked_hours) * 60) : null);
  return {
    day: String(r.date ?? r.login_time ?? '').slice(0, 10),
    loginAt,
    logoutAt,
    stillIn: !!loginAt && !logoutAt,
    // Timebox's own count of the day's hours (after lunch); none yet while still in
    workedMinutes: logoutAt ? worked : null,
    lunchMinutes: num(r.lunch_minutes),
    logoutEstimated: yes(r.logout_estimated),
  };
};

/** One person's Timebox month, as Timebox counts it. */
export const summaryRecord = (r) => ({
  daysPresent: num(r.days_present) ?? 0,
  expectedDays: num(r.expected_days) ?? 0,
  percent: num(r.attendance_percent),
  hoursWorked: num(r.hours_worked) ?? 0,
  excusedLeaveDays: num(r.excused_leave_days) ?? 0,
});

/** The day's Timebox plan (worklist): how many items, how many done. */
export const planRecord = (r) => {
  const items = r?.items && typeof r.items === 'object' ? r.items : {};
  const list = (Array.isArray(items.worklist) ? items.worklist : []).filter((i) => String(i?.content ?? '').trim());
  return { total: list.length, done: list.filter((i) => yes(i?.done)).length };
};

// ── linking members to Timebox ───────────────────────────────────────────────

/**
 * Map<memberId, { timeboxId, employeeId, via: 'login' | 'name' }> for the members that can be linked. A login's employee wins; a member
 * without one is matched by name only to a single employee who has a Timebox id.
 */
export const timeboxLinks = async (members) => {
  const out = new Map();
  if (!members.length) return out;
  const userIds = members.map((m) => m.userId).filter((v) => v && mongoose.isValidObjectId(String(v)));
  const users = userIds.length ? await User.find({ _id: { $in: userIds } }).select('employeeId').lean() : [];
  const empByUser = new Map(users.filter((u) => u.employeeId).map((u) => [idOf(u), idOf(u.employeeId)]));
  const empIds = [...new Set([...empByUser.values()])];
  const emps = empIds.length ? await Employee.find({ _id: { $in: empIds } }).select('timeboxEmployeeId').lean() : [];
  const tbByEmp = new Map(emps.filter((e) => e.timeboxEmployeeId != null).map((e) => [idOf(e), e.timeboxEmployeeId]));
  for (const m of members) {
    const emp = m.userId ? empByUser.get(idOf(m.userId)) : null;
    if (emp && tbByEmp.has(emp)) out.set(idOf(m), { timeboxId: Number(tbByEmp.get(emp)), employeeId: emp, via: 'login' });
  }
  for (const m of members) {
    if (out.has(idOf(m)) || (m.userId && empByUser.get(idOf(m.userId)))) continue; // a login with its own employee is never second-guessed
    const name = String(m.name ?? '').trim();
    if (!name) continue;
    const rx = new RegExp(`^\\s*${escapeRx(name)}\\s*$`, 'i');
    const same = await Employee.find({ $or: [{ name: rx }, { timeboxName: rx }], timeboxEmployeeId: { $ne: null } }).select('timeboxEmployeeId').limit(2).lean();
    if (same.length === 1) out.set(idOf(m), { timeboxId: Number(same[0].timeboxEmployeeId), employeeId: idOf(same[0]), via: 'name' });
  }
  return out;
};

// ── what the screens ask for ─────────────────────────────────────────────────

/**
 * Timebox for these members over from..to: { status, links, days: Map<"memberId|day", dayRecord>, summary: Map<memberId, summaryRecord>,
 * plans: Map<"memberId|day", planRecord> }. status = { mode: 'live' | 'off', ok, problem, linked, unlinked: [names] }.
 * [want]: which of 'days' | 'summary' | 'plans' to read.
 */
export const marketingTimebox = async (members, from, to, want = ['days']) => {
  const empty = { days: new Map(), summary: new Map(), plans: new Map() };
  if (timeboxMode() !== 'live') {
    return { status: { mode: 'off', ok: false, problem: TIMEBOX_NOT_CONNECTED, linked: 0, unlinked: [] }, links: new Map(), ...empty };
  }
  const links = await timeboxLinks(members);
  const unlinked = members.filter((m) => !links.has(idOf(m))).map((m) => m.name);
  const status = { mode: 'live', ok: true, problem: '', linked: links.size, unlinked };
  if (!links.size) return { status, links, ...empty };
  const memberOfTb = new Map([...links].map(([mid, l]) => [l.timeboxId, mid]));
  try {
    const [att, sum, plan] = await Promise.all([
      want.includes('days') ? read('attendance', { from, to }) : [],
      want.includes('summary') ? read('attendance_summary', { from, to }) : [],
      want.includes('plans') ? read('timebox', { from, to }) : [],
    ]);
    const days = new Map();
    for (const r of att) {
      const mid = memberOfTb.get(tbIdOf(r));
      if (!mid) continue;
      const rec = dayRecord(r);
      if (rec.day) days.set(`${mid}|${rec.day}`, rec);
    }
    const summary = new Map();
    for (const r of sum) {
      const mid = memberOfTb.get(tbIdOf(r));
      if (mid) summary.set(mid, summaryRecord(r));
    }
    const plans = new Map();
    for (const r of plan) {
      const mid = memberOfTb.get(tbIdOf(r));
      const day = String(r.date ?? r.login_time ?? '').slice(0, 10);
      if (mid && day) plans.set(`${mid}|${day}`, planRecord(r));
    }
    return { status, links, days, summary, plans };
  } catch (err) {
    return { status: { ...status, ok: false, problem: plainProblem(err) }, links, ...empty };
  }
};
