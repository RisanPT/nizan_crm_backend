/**
 * timeboxController.js
 *
 * HR + Accounts integration for the Timebox attendance software.
 *
 *   HR   →  employee directory, daily attendance, monthly attendance summary,
 *           and the daily "timebox" worklist / braindump / schedule.
 *   Accounts → attendance-driven payroll: joins each Timebox attendance summary
 *           to the matching CRM Employee (by timeboxEmployeeId first, then email,
 *           then name) and computes an attendance pro-rated payable, then can
 *           generate administrative salary slips from it.
 *
 * Data comes from services/timeboxClient.js which is live-or-demo transparent.
 *
 * Matching priority:
 *   1. CRM Employee.timeboxEmployeeId === Timebox id     → matchedBy: 'id'
 *   2. CRM Employee.email === Timebox email (normalised) → matchedBy: 'email'
 *   3. CRM Employee.name === Timebox name (normalised)   → matchedBy: 'name'
 *   4. No match                                          → matchedBy: 'none'
 */

import { timeboxFetch, timeboxMode } from '../services/timeboxClient.js';
import Employee from '../models/Employee.js';
import Salary from '../models/Salary.js';
import Department from '../models/Department.js';
import LeaveRequest from '../models/LeaveRequest.js';
import AttendanceRegularization from '../models/AttendanceRegularization.js';
import { isPayrollLocked } from '../models/PayrollLock.js';
import { canManagePayroll } from '../utils/hrAccess.js';
import { getHrScope } from '../utils/hrDeptScope.js';

// Absent days paid automatically each month when an employee has no approved
// leave (company policy; previously hard-coded as 1). Set 0 to switch it off.
const FREE_ABSENT_DAYS = (() => {
  const v = Number(process.env.PAYROLL_FREE_ABSENT_DAYS ?? 1);
  return Number.isFinite(v) && v >= 0 ? v : 1;
})();

// ── helpers ───────────────────────────────────────────────────────────────────

const norm = (s) => String(s || '').trim().toLowerCase();
const round0 = (n) => Math.round((Number(n) || 0));

// Timebox department name → CRM Employee.category enum.
const categoryForDept = (dept) => {
  const n = norm(dept);
  if (n === 'sales') return 'sales';
  if (n === 'it') return 'it';
  if (n === 'marketing') return 'marketing';
  // Timebox staff are office/administrative staff (HR/Accounts/Finance/CRM/etc.)
  // — NEVER the creative/operations (makeup) team. Any other department name
  // (incl. "Operations") collapses to administrative so imported staff never
  // land in creative/operations and leak into artist pickers.
  return 'administrative';
};

/** Default reporting range = the current calendar month (IST-ish). */
function defaultRange() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-based
  const first = new Date(Date.UTC(y, m, 1));
  const last = new Date(Date.UTC(y, m + 1, 0));
  const iso = (d) => d.toISOString().slice(0, 10);
  return { from: iso(first), to: iso(last) };
}

/** Helper to count weekend days (Saturdays and Sundays) in a given date range. */
function countWeekends(fromStr, toStr) {
  let start = new Date(`${fromStr}T00:00:00`);
  let end = new Date(`${toStr}T00:00:00`);
  let count = 0;
  let current = new Date(start);
  while (current <= end) {
    const day = current.getDay();
    if (day === 0 || day === 6) count++;
    current.setDate(current.getDate() + 1);
  }
  return count;
}

/**
 * Build lookup maps of CRM employees keyed by:
 *   - timeboxEmployeeId (Number)   → for primary binding match
 *   - normalised email             → for email match
 *   - normalised name              → for name match
 */
async function crmEmployeeIndex() {
  const emps = await Employee.find({}).lean();
  const byTimeboxId = new Map();
  const byEmail = new Map();
  const byName = new Map();
  for (const e of emps) {
    if (e.timeboxEmployeeId != null) byTimeboxId.set(Number(e.timeboxEmployeeId), e);
    if (e.email) byEmail.set(norm(e.email), e);
    if (e.name) byName.set(norm(e.name), e);
  }
  return { byTimeboxId, byEmail, byName, all: emps };
}

/**
 * Match a Timebox employee record to a CRM employee.
 * Returns { crm, matchedBy } where matchedBy is 'id' | 'email' | 'name' | 'none'.
 */
function matchCrm(index, { id, email, name }) {
  // 1. Explicit Timebox ID binding (set by sync-employees)
  if (id != null) {
    const hit = index.byTimeboxId.get(Number(id));
    if (hit) return { crm: hit, matchedBy: 'id' };
  }
  // 2. Email match
  if (email) {
    const hit = index.byEmail.get(norm(email));
    if (hit) return { crm: hit, matchedBy: 'email' };
  }
  // 3. Exact name match
  if (name) {
    const hit = index.byName.get(norm(name));
    if (hit) return { crm: hit, matchedBy: 'name' };
  }
  return { crm: null, matchedBy: 'none' };
}

/**
 * Send a Timebox failure to the app as a human message, keeping the technical
 * reason (API key names, raw fetch errors) in the server log only. Database
 * errors are passed through as a 500 so the global sanitizer maps them
 * (instead of being mislabelled as a Timebox outage).
 */
function sendTimeboxError(res, err, context) {
  const msg = String(err?.message || '');
  console.error(`[timebox] ${context}:`, msg);
  const name = String(err?.name || '');
  if (/^Mongo|CastError|ValidationError|DocumentNotFoundError/.test(name) || err?.code === 11000) {
    return res.status(500).json({ ok: false, message: msg });
  }
  if (name === 'TimeoutError' || name === 'AbortError') {
    return res.status(504).json({
      ok: false,
      message: 'The Timebox attendance system is taking too long to respond. Please try again.',
    });
  }
  if (/rejected the API key|TIMEBOX_/i.test(msg)) {
    return res.status(502).json({
      ok: false,
      message: 'The Timebox connection is not set up correctly. Please contact your administrator.',
    });
  }
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET|EAI_AGAIN|returned HTTP/i.test(msg)) {
    return res.status(502).json({
      ok: false,
      message: 'Could not reach the Timebox attendance system right now. Please try again later.',
    });
  }
  // A readable reason reported by Timebox itself (body.ok === false).
  return res.status(502).json({ ok: false, message: msg ? `Timebox: ${msg}` : 'Timebox request failed. Please try again.' });
}


// ── Department-head scoping for attendance views ─────────────────────────────
// HR-wide users and payroll users see everyone; another department head sees
// only rows for their own department's staff (matched Timebox → CRM the same
// way payroll does). Returns the rows unchanged when no scoping applies.
async function scopeAttendanceRows(req, rows, pick) {
  if (!Array.isArray(rows) || canManagePayroll(req.user)) return rows;
  const scope = await getHrScope(req, ['staff']);
  if (scope.wide) return rows;
  const allowed = new Set(scope.employeeIds || []);
  const index = await crmEmployeeIndex();
  return rows.filter((row) => {
    const who = pick(row) || {};
    const { crm } = matchCrm(index, who);
    return crm?._id && allowed.has(String(crm._id));
  });
}
const pickNested = (r) => ({ id: r?.employee?.id ?? r?.employee_id, email: r?.employee?.email || r?.email || '', name: r?.employee?.name || r?.employee_name || r?.name || '' });
const pickFlat = (r) => ({ id: r?.id, email: r?.email || '', name: r?.full_name || r?.name || '' });

// ── GET /api/timebox/employees ────────────────────────────────────────────────
export const getTimeboxEmployees = async (req, res) => {
  try {
    const result = await timeboxFetch('employees');
    res.json({
      ok: true,
      mode: timeboxMode(),
      source: result.source,
      count: result.count,
      generated_at: result.generated_at,
      data: await scopeAttendanceRows(req, result.data, pickFlat),
    });
  } catch (err) {
    sendTimeboxError(res, err, 'Timebox error');
  }
};

// ── GET /api/timebox/attendance?from=&to=&employee_id= ────────────────────────
export const getTimeboxAttendance = async (req, res) => {
  try {
    const { from, to, employee_id } = req.query;
    const result = await timeboxFetch('attendance', { from, to, employee_id });
    res.json({
      ok: true,
      mode: timeboxMode(),
      source: result.source,
      count: result.count,
      range: result.range || (from || to ? { from, to } : undefined),
      data: await scopeAttendanceRows(req, result.data, pickNested),
    });
  } catch (err) {
    sendTimeboxError(res, err, 'Timebox error');
  }
};

// ── GET /api/timebox/attendance-summary?from=&to= ─────────────────────────────
export const getAttendanceSummary = async (req, res) => {
  try {
    const range = req.query.from || req.query.to ? req.query : defaultRange();
    const result = await timeboxFetch('attendance_summary', {
      from: range.from,
      to: range.to,
    });
    res.json({
      ok: true,
      mode: timeboxMode(),
      source: result.source,
      count: result.count,
      range: result.range || { from: range.from, to: range.to },
      data: await scopeAttendanceRows(req, result.data, pickNested),
    });
  } catch (err) {
    sendTimeboxError(res, err, 'Timebox error');
  }
};

// ── GET /api/timebox/days?from=&to=&employee_id= ──────────────────────────────
// The Timebox "timebox" resource — daily worklist / braindump / schedule.
export const getTimeboxDays = async (req, res) => {
  try {
    const { from, to, employee_id } = req.query;
    const result = await timeboxFetch('timebox', { from, to, employee_id });
    res.json({
      ok: true,
      mode: timeboxMode(),
      source: result.source,
      count: result.count,
      range: result.range || (from || to ? { from, to } : undefined),
      data: await scopeAttendanceRows(req, result.data, pickNested),
    });
  } catch (err) {
    sendTimeboxError(res, err, 'Timebox error');
  }
};

// ── POST /api/timebox/sync-employees ─────────────────────────────────────────
/**
 * Core synchronization worker.
 * Scan all Timebox employees, find matching CRM employee records by email or
 * name, and write back the `timeboxEmployeeId` + `timeboxName` onto the CRM
 * Employee document so future payroll runs use the permanent integer ID match.
 *
 * Safe to run multiple times (idempotent).
 * Returns a summary: { ok, mode, created, synced, alreadySynced, unmatched, conflictCount, conflicts, results, message }
 */
export async function performTimeboxEmployeeSync() {
  const empRes = await timeboxFetch('employees');
  const tbEmployees = empRes.data || [];

  // Build a fresh CRM index (by email + name — NOT by timeboxId yet, since
  // this is the sync that establishes those bindings).
  const crmEmps = await Employee.find({}).lean();
  const byEmail = new Map();
  const byName = new Map();
  for (const e of crmEmps) {
    if (e.email) byEmail.set(norm(e.email), e);
    if (e.name) byName.set(norm(e.name), e);
  }

  // Map a Timebox department name → our Department entity id (by name or key).
  const departments = await Department.find({}).lean();
  const deptByName = new Map(departments.map((d) => [norm(d.name), d._id]));
  const deptByKey = new Map(departments.map((d) => [d.key, d._id]));
  const deptIdForTimebox = (tbDept) => {
    const n = norm(tbDept);
    return deptByName.get(n) || deptByKey.get(n) || null;
  };

  let synced = 0;
  let created = 0;
  let alreadySynced = 0;
  let unmatched = 0;
  const conflicts = [];
  const results = [];

  for (const tb of tbEmployees) {
    const tbId = Number(tb.id);
    const tbEmail = norm(tb.email || '');
    const tbName = tb.full_name || tb.name || '';

    // Attempt match: email first, then name
    let crmMatch = tbEmail ? byEmail.get(tbEmail) : null;
    let matchedBy = crmMatch ? 'email' : null;

    if (!crmMatch && tbName) {
      crmMatch = byName.get(norm(tbName));
      if (crmMatch) matchedBy = 'name';
    }

    // No CRM match → CREATE the Timebox person as an administrative Employee,
    // slotted into their department. This is how Timebox staff are saved into
    // our DB and shown under the departments.
    if (!crmMatch) {
      const newEmp = await Employee.create({
        name: tbName || tb.email || `Timebox #${tbId}`,
        email: tb.email || '',
        role: 'staff',
        artistRole: 'staff',
        category: categoryForDept(tb.department),
        department: tb.department || 'Administrative',
        departmentId: deptIdForTimebox(tb.department),
        status: tb.active === false ? 'inactive' : 'active',
        timeboxEmployeeId: tbId,
        timeboxName: tbName,
      });
      created += 1;
      results.push({
        timeboxId: tbId,
        timeboxName: tbName,
        crmId: String(newEmp._id),
        crmName: newEmp.name,
        matched: true,
        action: 'created',
        department: newEmp.department,
      });
      continue;
    }

    // Check for conflicts: two Timebox employees binding to the same CRM employee
    if (crmMatch.timeboxEmployeeId != null && Number(crmMatch.timeboxEmployeeId) !== tbId) {
      conflicts.push({
        timeboxId: tbId,
        timeboxName: tbName,
        crmName: crmMatch.name,
        existingTimeboxId: crmMatch.timeboxEmployeeId,
      });
      results.push({
        timeboxId: tbId,
        timeboxName: tbName,
        crmId: String(crmMatch._id),
        crmName: crmMatch.name,
        matched: false,
        reason: 'conflict',
      });
      continue;
    }

    // Already synced with the same ID — just backfill the department if unset.
    if (Number(crmMatch.timeboxEmployeeId) === tbId) {
      if (!crmMatch.departmentId) {
        const did = deptIdForTimebox(tb.department);
        if (did) await Employee.findByIdAndUpdate(crmMatch._id, { departmentId: did });
      }
      alreadySynced += 1;
      results.push({
        timeboxId: tbId,
        timeboxName: tbName,
        crmId: String(crmMatch._id),
        crmName: crmMatch.name,
        matched: true,
        matchedBy,
        action: 'already_synced',
      });
      continue;
    }

    // Write the binding back to CRM (+ slot into their department if unset).
    const patch = { timeboxEmployeeId: tbId, timeboxName: tbName };
    if (!crmMatch.departmentId) {
      const did = deptIdForTimebox(tb.department);
      if (did) patch.departmentId = did;
    }
    await Employee.findByIdAndUpdate(crmMatch._id, patch);

    synced += 1;
    results.push({
      timeboxId: tbId,
      timeboxName: tbName,
      crmId: String(crmMatch._id),
      crmName: crmMatch.name,
      matched: true,
      matchedBy,
      action: 'synced',
    });
  }

  return {
    ok: true,
    mode: timeboxMode(),
    created,
    synced,
    alreadySynced,
    unmatched,
    conflictCount: conflicts.length,
    conflicts,
    results,
    message: `Imported ${created} new staff, linked ${synced}, ${alreadySynced} already up to date${conflicts.length ? `, ${conflicts.length} conflicts` : ''}.`,
  };
}

export const syncEmployees = async (req, res) => {
  try {
    const summary = await performTimeboxEmployeeSync();
    res.json(summary);
  } catch (err) {
    sendTimeboxError(res, err, 'Timebox sync error');
  }
};

// ── payroll computation shared by preview + generate ──────────────────────────
/**
 * Build attendance-pro-rated payroll rows for a date range.
 * Returns { rows, totals, range }.
 */
async function buildPayroll({ from, to }) {
  const range = from || to ? { from, to } : defaultRange();

  const start = new Date(`${range.from}T00:00:00`);
  const targetMonth = start.getMonth() + 1;
  const targetYear = start.getFullYear();

  const [empRes, sumRes, index, approvedLeaves] = await Promise.all([
    timeboxFetch('employees'),
    timeboxFetch('attendance_summary', { from: range.from, to: range.to }),
    crmEmployeeIndex(),
    LeaveRequest.find({
      status: 'approved',
      $or: [
        { month: targetMonth, year: targetYear },
        { fromDate: { $lte: new Date(`${range.to}T23:59:59`) }, toDate: { $gte: new Date(`${range.from}T00:00:00`) } },
      ],
    }).populate('leaveTypeId', 'paid name').lean(),
  ]);

  // Map CRM employeeId -> approved paid leave days INSIDE this range. A leave
  // from Jan 30 to Feb 2 counts 2 days in January and 2 in February — not 4
  // in both.
  const rangeStart = new Date(`${range.from}T00:00:00`);
  const rangeEnd = new Date(`${range.to}T23:59:59`);
  const DAY = 24 * 60 * 60 * 1000;
  const daysInside = (lr) => {
    const total = Number(lr.days) || 0;
    if (!lr.fromDate || !lr.toDate) return total;
    const a = Math.max(new Date(lr.fromDate).setHours(0, 0, 0, 0), rangeStart.getTime());
    const b = Math.min(new Date(lr.toDate).setHours(0, 0, 0, 0), rangeEnd.getTime());
    if (b < a) return 0;
    const overlap = Math.floor((b - a) / DAY) + 1;
    return Math.min(total, overlap);
  };
  const approvedLeaveMap = new Map();
  for (const lr of approvedLeaves || []) {
    // Unpaid leave (LWP) does not offset absence deductions
    if (lr.leaveTypeId && lr.leaveTypeId.paid === false) continue;
    const k = String(lr.employeeId);
    approvedLeaveMap.set(k, (approvedLeaveMap.get(k) || 0) + daysInside(lr));
  }

  // Approved attendance regularizations (missed punch, WFH, on duty…) credit
  // the day as present. 'wrong_time' only fixes timings, so it isn't counted.
  // One credit per employee per date.
  const regs = await AttendanceRegularization.find({
    status: 'approved',
    type: { $ne: 'wrong_time' },
    date: { $gte: rangeStart, $lte: rangeEnd },
  }).select('employeeId date').lean();
  const regDatesMap = new Map();
  for (const r of regs) {
    const k = String(r.employeeId);
    if (!regDatesMap.has(k)) regDatesMap.set(k, new Set());
    regDatesMap.get(k).add(new Date(r.date).toISOString().slice(0, 10));
  }

  // Timebox employee id → { email, name, ... }
  const tbById = new Map();
  for (const e of empRes.data) tbById.set(Number(e.id), e);

  const rows = [];
  for (const s of sumRes.data) {
    const tbId = Number(s.employee?.id);
    const tb = tbById.get(tbId) || {};
    const email = tb.email || '';
    const name = s.employee?.name || tb.full_name || '';

    const { crm, matchedBy } = matchCrm(index, { id: tbId, email, name });

    const baseSalary = round0(crm?.baseSalary);
    const allowances = round0(crm?.allowances);
    const deductions = round0(crm?.deductions);

    let expectedDays = Number(s.expected_days) || 0;
    const daysPresent = Number(s.days_present) || 0;
    const hoursWorked = Number(s.hours_worked) || 0;
    let attendancePercent = Number(s.attendance_percent) || 0;

    const department = s.department || tb.department || crm?.department || '';
    
    // IT Department weekend logic override
    if (department.toLowerCase() === 'it') {
      const weekends = countWeekends(range.from, range.to);
      expectedDays = Math.max(0, expectedDays - weekends);
      if (expectedDays > 0) {
        attendancePercent = Math.round(Math.min(100, (daysPresent / expectedDays) * 100));
      } else {
        attendancePercent = 100;
      }
    }

    // Reconcile approved paid leave from CRM LeaveRequest records
    const approvedLeaveDays = crm?._id ? (approvedLeaveMap.get(String(crm._id)) || 0) : 0;
    const regularizedDays = crm?._id ? (regDatesMap.get(String(crm._id))?.size || 0) : 0;
    let effectiveDaysPresent = daysPresent;
    let freeDaysApplied = 0;
    const absentDays = expectedDays - daysPresent;
    if (absentDays > 0) {
      // Approved paid leave covers absences; with no approved leave, the
      // company's monthly free-absence allowance (PAYROLL_FREE_ABSENT_DAYS,
      // default 1) applies instead.
      freeDaysApplied = approvedLeaveDays > 0 ? 0 : Math.min(FREE_ABSENT_DAYS, absentDays);
      const protectedDays = (approvedLeaveDays > 0 ? approvedLeaveDays : freeDaysApplied) + regularizedDays;
      effectiveDaysPresent += Math.min(absentDays, protectedDays);
    }

    const factor =
      expectedDays > 0 ? Math.min(1, effectiveDaysPresent / expectedDays) : (effectiveDaysPresent > 0 ? 1 : 0);
    const proratedBase = round0(baseSalary * factor);
    const absenceDeduction = Math.max(0, baseSalary - proratedBase);
    const netPayable = Math.max(0, proratedBase + allowances - deductions);

    rows.push({
      timeboxId: tbId,
      name,
      email,
      department,
      matched: !!crm,
      matchedBy,
      crmEmployeeId: crm?._id ? String(crm._id) : null,
      approvedLeaveDays,
      regularizedDays,
      freeDaysApplied,
      salaryType: crm?.salaryType || null,
      baseSalary,
      allowances,
      deductions,
      expectedDays,
      daysPresent,
      hoursWorked,
      attendancePercent,
      attendanceFactor: Number(factor.toFixed(4)),
      proratedBase,
      absenceDeduction,
      netPayable,
    });
  }

  rows.sort((a, b) => a.name.localeCompare(b.name));

  const totals = rows.reduce(
    (acc, r) => {
      acc.baseSalary += r.baseSalary;
      acc.proratedBase += r.proratedBase;
      acc.absenceDeduction += r.absenceDeduction;
      acc.netPayable += r.netPayable;
      if (r.matched) acc.matched += 1;
      else acc.unmatched += 1;
      return acc;
    },
    { baseSalary: 0, proratedBase: 0, absenceDeduction: 0, netPayable: 0, matched: 0, unmatched: 0 }
  );

  return { rows, totals, range };
}

// ── GET /api/timebox/payroll-preview?from=&to= ────────────────────────────────
export const getPayrollPreview = async (req, res) => {
  try {
    const { from, to } = req.query;
    const { rows, totals, range } = await buildPayroll({ from, to });
    res.json({
      ok: true,
      mode: timeboxMode(),
      range,
      totals,
      count: rows.length,
      freeAbsentDays: FREE_ABSENT_DAYS,
      data: rows,
    });
  } catch (err) {
    sendTimeboxError(res, err, 'Timebox payroll error');
  }
};

// ── POST /api/timebox/generate-payroll ────────────────────────────────────────
// Body: { from, to, month?, year?, dryRun? }
// Creates/updates administrative salary slips pro-rated by attendance.
// Never touches slips already marked `paid`.
export const generatePayrollFromAttendance = async (req, res) => {
  try {
    const { from, to, month, year, dryRun } = req.body || {};
    const { rows, range } = await buildPayroll({ from, to });

    // Derive the target month/year from the range start unless overridden.
    const start = new Date(`${range.from}T00:00:00`);
    const targetMonth = Number(month) || start.getMonth() + 1;
    const targetYear = Number(year) || start.getFullYear();

    if (!dryRun && (await isPayrollLocked(targetMonth, targetYear))) {
      return res.status(409).json({
        ok: false,
        message: `Payroll for ${targetMonth}/${targetYear} is locked. Ask an admin to unlock it first.`,
      });
    }

    let created = 0;
    let updated = 0;
    let skippedPaid = 0;
    let unmatched = 0;
    const affected = [];

    // One net-pay formula everywhere (same as editing a slip).
    const netOf = (s) => Math.max(
      0,
      (s.baseSalary || 0) + (s.incentives || 0) + (s.roomRent || 0) +
        (s.allowances || 0) + (s.bonus || 0) - (s.deductions || 0),
    );

    for (const r of rows) {
      if (!r.matched || !r.crmEmployeeId) {
        unmatched += 1;
        continue;
      }

      const totalDeductions = r.deductions + r.absenceDeduction;
      const extras = [
        r.approvedLeaveDays ? `${r.approvedLeaveDays} paid leave day(s)` : '',
        r.regularizedDays ? `${r.regularizedDays} regularized day(s)` : '',
        r.freeDaysApplied ? `${r.freeDaysApplied} free absent day(s)` : '',
      ].filter(Boolean).join(', ');
      const attendanceNote =
        `Attendance ${r.daysPresent}/${r.expectedDays} days ` +
        `(${r.attendancePercent}%) · ${r.hoursWorked}h worked. ` +
        (extras ? `Credited: ${extras}. ` : '') +
        `Absence deduction ₹${r.absenceDeduction}. ` +
        `Matched by: ${r.matchedBy}. ` +
        `[Timebox ${range.from}→${range.to}]`;

      const existing = await Salary.findOne({
        employeeId: r.crmEmployeeId,
        month: targetMonth,
        year: targetYear,
      });

      // Paid and cancelled slips are final — never rewritten.
      if (existing && (existing.status === 'paid' || existing.status === 'cancelled')) {
        skippedPaid += 1;
        continue;
      }

      if (existing) {
        // Keep every manual adjustment: only the attendance part of the
        // deductions is replaced. Legacy slips (no tracked attendance part)
        // fall back to the employee's standard deductions, as before.
        const manualDeductions = existing.attendanceDeduction != null
          ? Math.max(0, (existing.deductions || 0) - existing.attendanceDeduction)
          : r.deductions;
        const next = {
          baseSalary: r.baseSalary,
          allowances: r.allowances,
          incentives: existing.incentives,
          roomRent: existing.roomRent,
          bonus: existing.bonus,
          deductions: manualDeductions + r.absenceDeduction,
        };
        const netAmount = netOf(next);

        if (dryRun) {
          affected.push({ name: r.name, netAmount, action: 'update' });
          continue;
        }

        Object.assign(existing, next);
        existing.attendanceDeduction = r.absenceDeduction;
        existing.netAmount = netAmount;
        existing.department = existing.department || r.department;
        // Replace the previous attendance note; keep anything HR typed.
        const manualNotes = String(existing.notes || '')
          .split('\n')
          .filter((l) => l.trim() && !l.startsWith('Attendance '))
          .join('\n');
        existing.notes = [manualNotes, attendanceNote].filter(Boolean).join('\n');
        // Status and category stay as HR left them (a draft stays a draft).
        await existing.save();
        updated += 1;
        affected.push({ name: r.name, netAmount, action: 'update', matchedBy: r.matchedBy });
      } else {
        const netAmount = netOf({ baseSalary: r.baseSalary, allowances: r.allowances, deductions: totalDeductions });
        const notes = attendanceNote;
        if (dryRun) {
          affected.push({ name: r.name, netAmount, action: 'create' });
          continue;
        }
        const crm = await Employee.findById(r.crmEmployeeId).lean();
        await Salary.create({
          employeeId: r.crmEmployeeId,
          employeeName: r.name,
          employeeCategory: 'administrative',
          department: r.department || crm?.department || 'General',
          role: crm?.role || 'Staff',
          month: targetMonth,
          year: targetYear,
          salaryType: r.salaryType || crm?.salaryType || 'fixed_monthly',
          baseSalary: r.baseSalary,
          allowances: r.allowances,
          bonus: 0,
          deductions: totalDeductions,
          attendanceDeduction: r.absenceDeduction,
          netAmount,
          status: 'approved_by_hr',
          notes,
          bankDetails: {
            bankName: crm?.bankName || '',
            accountNumber: crm?.accountNumber || '',
            ifscCode: crm?.ifscCode || '',
            upiId: crm?.upiId || '',
          },
          approvedBy: req.user?._id || null,
          approvedAt: new Date(),
        });
        created += 1;
        affected.push({ name: r.name, netAmount, action: 'create', matchedBy: r.matchedBy });
      }
    }

    res.json({
      ok: true,
      dryRun: !!dryRun,
      month: targetMonth,
      year: targetYear,
      range,
      created,
      updated,
      skippedPaid,
      unmatched,
      affected,
      message: dryRun
        ? `Preview: ${affected.length} slips would be written (${unmatched} unmatched skipped).`
        : `Generated ${created} and updated ${updated} administrative salary slips for ${targetMonth}/${targetYear}. ${skippedPaid} paid slips left untouched, ${unmatched} unmatched.`,
    });
  } catch (err) {
    sendTimeboxError(res, err, 'Timebox payroll generation error');
  }
};
