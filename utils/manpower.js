// MANPOWER REQUESTS: a project needs more people, and HR sorts it out.
//
//   - Whoever runs the project asks for N people (a role, from – to, how much of their time).
//   - HR answers each seat one of three ways: a person already on staff (their department's head must release them when they
//     are not already on the project), a new hire (a hiring plan is raised), or a contractor — or declines the request.
//   - A seat that costs money (a hire, a contractor) cannot be committed beyond what is left of the project's approved budget:
//     the project manager has to raise the project's cost first (and the finance head approves it).
//   - People already on staff cost nothing extra here: their salary is paid anyway, so their time is tracked, not charged.
//
// Pure — no database. tests/manpower.test.js.

import { cleanAmount } from './projectCost.js';

export const URGENCIES = ['normal', 'urgent'];
export const MAX_HEADCOUNT = 20;
export const MAX_SPAN_DAYS = 5 * 366;

/// The statuses of a request: submitted (nobody has touched it) · in_progress · fulfilled · declined · cancelled.
export const REQUEST_STATUSES = ['submitted', 'in_progress', 'fulfilled', 'declined', 'cancelled'];
export const OPEN_STATUSES = ['submitted', 'in_progress'];

/// How a seat is covered, and where it stands: awaiting_release (the person's head has to let them go) · assigned ·
/// hiring (a hiring plan is open; someone is to be allocated when they join) · refused (their head said no: the seat is open again).
export const LINE_TYPES = ['internal', 'hire', 'contract'];
export const LINE_STATES = ['awaiting_release', 'assigned', 'hiring', 'refused'];

const HR_NAMES = ['hr', 'human resources'];

export const isHrDepartment = (name) => HR_NAMES.includes(String(name ?? '').trim().toLowerCase());

/// HR (the HR department's people) and administrators handle manpower requests.
export const canHandleManpower = ({ role, deptName }) => String(role ?? '').trim().toLowerCase() === 'admin' || isHrDepartment(deptName);

/// A day from "2026-11-20" (or an ISO timestamp, or a Date), as the UTC midnight of that day; null when it is not a date.
/// A date written as text keeps the day it says, wherever the reader is; a Date is read by its UTC day (the way days are stored).
export const parseDay = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? null : new Date(Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate()));
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v).trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const out = new Date(Date.UTC(y, mo - 1, d));
  // 2026-02-31 is not a day
  return out.getUTCFullYear() === y && out.getUTCMonth() === mo - 1 && out.getUTCDate() === d ? out : null;
};

const DAY = 24 * 60 * 60 * 1000;

/**
 * A request as filed, checked and tidied.
 * @returns {{ roleTitle, skills, headcount, startDate, endDate, allocationPercent, urgency, reason, estimatedCost } | { error: string, code: string }}
 */
export const validateRequest = (input = {}) => {
  const roleTitle = String(input.roleTitle ?? '').trim();
  if (roleTitle.length < 2) return { error: 'Say what role is needed.', code: 'ROLE_REQUIRED' };
  const headcount = Number(input.headcount ?? 1);
  if (!Number.isInteger(headcount) || headcount < 1 || headcount > MAX_HEADCOUNT) {
    return { error: `Ask for between 1 and ${MAX_HEADCOUNT} people.`, code: 'HEADCOUNT_INVALID' };
  }
  const startDate = parseDay(input.startDate);
  const endDate = parseDay(input.endDate);
  if (!startDate || !endDate) return { error: 'Give the dates the people are needed from and to.', code: 'DATES_REQUIRED' };
  if (endDate < startDate) return { error: 'The end date is before the start date.', code: 'DATES_INVALID' };
  if ((endDate - startDate) / DAY > MAX_SPAN_DAYS) return { error: 'That is longer than five years.', code: 'DATES_INVALID' };
  const percent = input.allocationPercent === undefined || input.allocationPercent === '' ? 100 : Number(input.allocationPercent);
  if (!Number.isInteger(percent) || percent < 5 || percent > 100) return { error: 'How much of their time: between 5% and 100%.', code: 'ALLOCATION_INVALID' };
  const urgency = input.urgency === undefined || input.urgency === '' ? 'normal' : String(input.urgency);
  if (!URGENCIES.includes(urgency)) return { error: 'Urgency is normal or urgent.', code: 'URGENCY_INVALID' };
  const reason = String(input.reason ?? '').trim();
  if (reason.length < 3) return { error: 'Say why more people are needed.', code: 'REASON_REQUIRED' };
  let estimatedCost = 0;
  if (input.estimatedCost !== undefined && input.estimatedCost !== null && input.estimatedCost !== '') {
    const c = cleanAmount(input.estimatedCost);
    if (c === null) return { error: 'The estimated cost must be a number.', code: 'COST_INVALID' };
    estimatedCost = c;
  }
  return {
    roleTitle: roleTitle.slice(0, 80),
    skills: String(input.skills ?? '').trim().slice(0, 300),
    headcount,
    startDate,
    endDate,
    allocationPercent: percent,
    urgency,
    reason: reason.slice(0, 500),
    estimatedCost,
  };
};

/// Do two stretches of days (both ends included) overlap?
export const overlaps = (a, b) => !!a.from && !!a.to && !!b.from && !!b.to && a.from <= b.to && b.from <= a.to;

/// How much of a person's time is spoken for in [from, to]: the allocations that overlap it, added up (cautiously — two
/// allocations that merely touch the window both count).
export const loadOf = (allocations, from, to) =>
  allocations.filter((a) => a.status !== 'ended' && overlaps({ from: a.from, to: a.to }, { from, to })).reduce((sum, a) => sum + (Number(a.percent) || 0), 0);

/// free (comfortably room) · tight (room, but not much) · busy (on leave, or this would take them past 100%) — judged WITH the
/// time being asked for added to what they already have.
export const levelFor = ({ load = 0, add = 0, onLeave = false }) => {
  const after = load + add;
  if (onLeave || after > 100) return 'busy';
  return after >= 70 ? 'tight' : 'free';
};

/// How many seats the lines cover (a refused line covers none).
export const coveredSeats = (lines) => lines.filter((l) => l.state !== 'refused').reduce((n, l) => n + (Number(l.seats) || 1), 0);

/// How many seats are still open.
export const seatsLeft = (headcount, lines) => Math.max(0, headcount - coveredSeats(lines));

/// Where a request stands, from its lines.
export const requestStatus = ({ status, headcount, lines = [] }) => {
  if (status === 'declined' || status === 'cancelled') return status;
  if (lines.length === 0) return 'submitted';
  const assigned = lines.filter((l) => l.state === 'assigned').reduce((n, l) => n + (Number(l.seats) || 1), 0);
  const waiting = lines.some((l) => l.state === 'awaiting_release' || l.state === 'hiring');
  return assigned >= headcount && !waiting ? 'fulfilled' : 'in_progress';
};

/// Does covering this seat with a person from [employeeDept] need that department's head to let them go? Not when their
/// department is already on the project.
export const needsRelease = ({ employeeDept, projectDepartments }) => {
  const dept = String(employeeDept ?? '').trim().toLowerCase();
  if (!dept) return false;
  return !projectDepartments.some((d) => String(d ?? '').trim().toLowerCase() === dept);
};

/// Is there room in the project's approved budget for [cost]? With no approved budget at all, any cost is short.
export const budgetRoom = ({ limit = 0, used = 0, cost = 0 }) => {
  const available = Math.round((limit - used) * 100) / 100;
  if (!(cost > 0)) return { short: false, shortfall: 0, available };
  if (!(limit > 0)) return { short: true, shortfall: cost, available: 0 };
  const short = cost > available;
  return { short, shortfall: short ? Math.round((cost - Math.max(available, 0)) * 100) / 100 : 0, available };
};

/// Who may raise a request for a project: those who run it, and the lead of a department that works on it.
export const mayRaise = ({ manage, leadsDepartment }) => !!(manage || leadsDepartment);
