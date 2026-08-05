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

// ── helpers ───────────────────────────────────────────────────────────────────

const norm = (s) => String(s || '').trim().toLowerCase();
const round0 = (n) => Math.round((Number(n) || 0));

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
      data: result.data,
    });
  } catch (err) {
    res.status(502).json({ ok: false, message: `Timebox error: ${err.message}` });
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
      data: result.data,
    });
  } catch (err) {
    res.status(502).json({ ok: false, message: `Timebox error: ${err.message}` });
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
      data: result.data,
    });
  } catch (err) {
    res.status(502).json({ ok: false, message: `Timebox error: ${err.message}` });
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
      data: result.data,
    });
  } catch (err) {
    res.status(502).json({ ok: false, message: `Timebox error: ${err.message}` });
  }
};

// ── POST /api/timebox/sync-employees ─────────────────────────────────────────
/**
 * Scan all Timebox employees, find matching CRM employee records by email or
 * name, and write back the `timeboxEmployeeId` + `timeboxName` onto the CRM
 * Employee document so future payroll runs use the permanent integer ID match.
 *
 * Safe to run multiple times (idempotent). Never creates new CRM employees.
 *
 * Returns a summary: { synced, alreadySynced, unmatched, conflicts }
 */
export const syncEmployees = async (req, res) => {
  try {
    const empRes = await timeboxFetch('employees');
    const tbEmployees = empRes.data;

    // Build a fresh CRM index (by email + name — NOT by timeboxId yet, since
    // this is the sync that establishes those bindings).
    const crmEmps = await Employee.find({}).lean();
    const byEmail = new Map();
    const byName = new Map();
    for (const e of crmEmps) {
      if (e.email) byEmail.set(norm(e.email), e);
      if (e.name) byName.set(norm(e.name), e);
    }

    let synced = 0;
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

      if (!crmMatch) {
        unmatched += 1;
        results.push({ timeboxId: tbId, timeboxName: tbName, matched: false, reason: 'no_crm_match' });
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

      // Already synced with the same ID — skip update
      if (Number(crmMatch.timeboxEmployeeId) === tbId) {
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

      // Write the binding back to CRM
      await Employee.findByIdAndUpdate(crmMatch._id, {
        timeboxEmployeeId: tbId,
        timeboxName: tbName,
      });

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

    res.json({
      ok: true,
      mode: timeboxMode(),
      synced,
      alreadySynced,
      unmatched,
      conflictCount: conflicts.length,
      conflicts,
      results,
      message: `Synced ${synced} employees. ${alreadySynced} already linked. ${unmatched} unmatched. ${conflicts.length} conflicts.`,
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: `Timebox sync error: ${err.message}` });
  }
};

// ── payroll computation shared by preview + generate ──────────────────────────
/**
 * Build attendance-pro-rated payroll rows for a date range.
 * Returns { rows, totals, range }.
 */
async function buildPayroll({ from, to }) {
  const range = from || to ? { from, to } : defaultRange();

  const [empRes, sumRes, index] = await Promise.all([
    timeboxFetch('employees'),
    timeboxFetch('attendance_summary', { from: range.from, to: range.to }),
    crmEmployeeIndex(),
  ]);

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

    // One paid leave per month logic for all departments
    let effectiveDaysPresent = daysPresent;
    const absentDays = expectedDays - daysPresent;
    if (absentDays > 0) {
      effectiveDaysPresent += Math.min(1, absentDays);
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
      data: rows,
    });
  } catch (err) {
    res.status(502).json({ ok: false, message: `Timebox payroll error: ${err.message}` });
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

    let created = 0;
    let updated = 0;
    let skippedPaid = 0;
    let unmatched = 0;
    const affected = [];

    for (const r of rows) {
      if (!r.matched || !r.crmEmployeeId) {
        unmatched += 1;
        continue;
      }

      const totalDeductions = r.deductions + r.absenceDeduction;
      const netAmount = Math.max(0, r.baseSalary + r.allowances - totalDeductions);
      const notes =
        `Attendance ${r.daysPresent}/${r.expectedDays} days ` +
        `(${r.attendancePercent}%) · ${r.hoursWorked}h worked. ` +
        `Absence deduction ₹${r.absenceDeduction}. ` +
        `Matched by: ${r.matchedBy}. ` +
        `[Timebox ${range.from}→${range.to}]`;

      const existing = await Salary.findOne({
        employeeId: r.crmEmployeeId,
        month: targetMonth,
        year: targetYear,
      });

      if (existing && existing.status === 'paid') {
        skippedPaid += 1;
        continue;
      }

      if (dryRun) {
        affected.push({ name: r.name, netAmount, action: existing ? 'update' : 'create' });
        continue;
      }

      if (existing) {
        existing.baseSalary = r.baseSalary;
        existing.allowances = r.allowances;
        existing.deductions = totalDeductions;
        existing.netAmount = netAmount;
        existing.employeeCategory = 'administrative';
        existing.department = r.department || existing.department;
        existing.notes = notes;
        existing.status = 'approved_by_hr';
        existing.approvedBy = req.user?._id || existing.approvedBy || null;
        existing.approvedAt = new Date();
        await existing.save();
        updated += 1;
        affected.push({ name: r.name, netAmount, action: 'update', matchedBy: r.matchedBy });
      } else {
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
    res.status(500).json({ ok: false, message: `Timebox payroll generation error: ${err.message}` });
  }
};
