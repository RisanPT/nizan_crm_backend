/**
 * timeboxController.js
 *
 * HR + Accounts integration for the Timebox attendance software.
 *
 *   HR   →  employee directory, daily attendance, monthly attendance summary,
 *           and the daily "timebox" worklist / braindump / schedule.
 *   Accounts → attendance-driven payroll: joins each Timebox attendance summary
 *           to the matching CRM Employee (by email, name fallback) and computes
 *           an attendance pro-rated payable, then can generate administrative
 *           salary slips from it.
 *
 * Data comes from services/timeboxClient.js which is live-or-demo transparent.
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

/** Build lookup maps of CRM employees keyed by normalised email and name. */
async function crmEmployeeIndex() {
  const emps = await Employee.find({}).lean();
  const byEmail = new Map();
  const byName = new Map();
  for (const e of emps) {
    if (e.email) byEmail.set(norm(e.email), e);
    if (e.name) byName.set(norm(e.name), e);
  }
  return { byEmail, byName, all: emps };
}

/** Match a Timebox employee record to a CRM employee (email first, then name). */
function matchCrm(index, { email, name }) {
  if (email) {
    const hit = index.byEmail.get(norm(email));
    if (hit) return hit;
  }
  if (name) {
    const hit = index.byName.get(norm(name));
    if (hit) return hit;
  }
  return null;
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

    const crm = matchCrm(index, { email, name });

    const baseSalary = round0(crm?.baseSalary);
    const allowances = round0(crm?.allowances);
    const deductions = round0(crm?.deductions);

    const expectedDays = Number(s.expected_days) || 0;
    const daysPresent = Number(s.days_present) || 0;
    const hoursWorked = Number(s.hours_worked) || 0;
    const attendancePercent = Number(s.attendance_percent) || 0;

    const factor =
      expectedDays > 0 ? Math.min(1, daysPresent / expectedDays) : 0;
    const proratedBase = round0(baseSalary * factor);
    const absenceDeduction = Math.max(0, baseSalary - proratedBase);
    const netPayable = Math.max(0, proratedBase + allowances - deductions);

    rows.push({
      timeboxId: tbId,
      name,
      email,
      department: s.department || tb.department || crm?.department || '',
      matched: !!crm,
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
        affected.push({ name: r.name, netAmount, action: 'update' });
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
        affected.push({ name: r.name, netAmount, action: 'create' });
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
