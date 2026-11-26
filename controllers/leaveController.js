import { escapeRegex } from '../utils/escapeRegex.js';
import mongoose from 'mongoose';
import LeaveType from '../models/LeaveType.js';
import LeaveRequest from '../models/LeaveRequest.js';
import Holiday from '../models/Holiday.js';
import CompOff from '../models/CompOff.js';
import Employee from '../models/Employee.js';
import TimeboxIgnoredEmployee from '../models/TimeboxIgnoredEmployee.js';
import User from '../models/User.js';
import ApprovalRequest from '../models/ApprovalRequest.js';
import { createApproval } from '../services/approvals.js';
import { dispatchLeaveCallback } from '../services/leaveCallbackService.js';
import Department from '../models/Department.js';
import { scopeFilter } from '../utils/hrDeptScope.js';
import { isLeaveDesk, leaveDeskUserIds } from '../utils/leaveDesk.js';
import { notify } from '../utils/notify.js';
import {
  asOfForYear,
  computeTypeBalance,
  countLeaveDays,
  daysInYear,
  normaliseWeeklyOffs,
  toDayKey,
  yearOf,
} from '../utils/leaveMath.js';

const empPopulate = { path: 'employeeId', select: 'name department profileImage' };

/// Leave of OTHER people (list, approve/reject, cancel, file on behalf,
/// balances, comp-offs, leave types, holidays) is the leave desk's job only:
/// admin + hr role (see utils/leaveDesk.js, owner decisions 2026-11-13/16).
/// The desk is company-wide, so there is no department scoping.

/// Legacy manager rule — now used ONLY for the read-only payroll feed, so a
/// payroll role that relied on it keeps working.
const canManageLeave = (user) => {
  const role = String(user?.role || '');
  if (role === 'admin' || role === 'manager' || role === 'hr') return true;
  if (user?.isDepartmentHead) return true;
  const perms = Array.isArray(user?.permissions) ? user.permissions : [];
  // The whole staff module or the payroll/employee sub-keys — not any staff.* key.
  return perms.some((p) => ['staff', 'staff.salaries', 'staff.employees', 'staff.attendance'].includes(p));
};

// No module key grants company-wide leave rights (see above): only
// admin/manager, the `staff` module and the HR department head are HR-wide.
const LEAVE_KEYS = [];

/// Narrow a list filter to the caller's department scope. `$and` so a dept
/// head can't widen it by passing another employee's id in the query.
const withLeaveScope = async (req, filter) => {
  const scope = await scopeFilter(req, LEAVE_KEYS);
  return Object.keys(scope).length ? { $and: [filter, scope] } : filter;
};

/// Leave desk (admin / hr role) — any employee.
const canManageLeaveFor = async (req, _employeeId) => isLeaveDesk(req);

/// Leave types / holidays are company master data — leave desk only.
const canEditLeaveMaster = async (req) => isLeaveDesk(req);

const parseDateMiddayUtc = (d) => {
  if (!d) return null;
  if (typeof d === 'string') {
    const m = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
      return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0));
    }
  }
  const dt = new Date(d);
  return new Date(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate(), 12, 0, 0));
};

const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const DAY_MS = 86400000;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/// 'YYYY-MM-DD' (IST day key) → '23 Nov 2026'.
const fmtDayKey = (key) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '';
};

/// One-line text for the Approvals card: type, days, leave dates and the
/// employee's reason, so the approver sees what they are deciding.
function leaveApprovalSummary({ typeName, days, from, to, halfDay, reason, extra }) {
  const fromKey = toDayKey(from);
  const toKey = toDayKey(to);
  const dates = !fromKey ? '' : fromKey === toKey || !toKey
    ? fmtDayKey(fromKey)
    : `${fmtDayKey(fromKey)} – ${fmtDayKey(toKey)}`;
  const half = halfDay && halfDay !== 'none' ? ` (${halfDay} half)` : '';
  let why = String(reason || '').replace(/\s+/g, ' ').trim();
  if (why.length > 140) why = `${why.slice(0, 137)}…`;
  return [
    `${typeName || 'Leave'} · ${days} day(s)`,
    dates ? `${dates}${half}` : '',
    extra || '',
    why ? `Reason: ${why}` : '',
  ].filter(Boolean).join(' · ');
}

/// An employee's weekly offs = their department's (by departmentId, else by the
/// free-text department name), else Sunday.
async function weeklyOffsFor(employee) {
  let dept = null;
  if (employee?.departmentId) {
    dept = await Department.findById(employee.departmentId).select('weeklyOffs').lean();
  }
  if (!dept && employee?.department) {
    dept = await Department.findOne({
      name: new RegExp(`^\\s*${escapeRegExp(String(employee.department).trim())}\\s*$`, 'i'),
    })
      .select('weeklyOffs')
      .lean();
  }
  return normaliseWeeklyOffs(dept?.weeklyOffs);
}

/// Holidays that could fall between two dates (plus recurring ones). A day of
/// slack either side covers holidays stored at midnight in another timezone.
const holidaysBetween = (from, to) =>
  Holiday.find({
    $or: [
      { date: { $gte: new Date(from.getTime() - DAY_MS), $lte: new Date(to.getTime() + DAY_MS) } },
      { recurring: true },
    ],
  })
    .select('date recurring type')
    .lean();

/// { weeklyOffs, holidays } for counting an employee's leave days in a range.
async function leaveDayContext(employee, from, to) {
  const [weeklyOffs, holidays] = await Promise.all([weeklyOffsFor(employee), holidaysBetween(from, to)]);
  return { weeklyOffs, holidays };
}

const todayKey = () => toDayKey(new Date());

/// Mongo filter for leaves overlapping calendar `year` on the India calendar
/// ({} for none/'all'). Bounds are IST midnights, like toDayKey().
const IST_MS = 330 * 60000;
export const yearOverlapFilter = (year) => {
  const y = Number(year);
  if (!year || year === 'all' || !Number.isInteger(y)) return {};
  return {
    fromDate: { $lt: new Date(Date.UTC(y + 1, 0, 1) - IST_MS) },
    toDate: { $gte: new Date(Date.UTC(y, 0, 1) - IST_MS) },
  };
};

/// Per-type balances for `employee` in `year` (monthly credit, carry-forward,
/// used, pending). `types` defaults to the active leave types.
async function computeBalances(employee, year, { types, asOfKey } = {}) {
  const typeList =
    types || (await LeaveType.find({ active: true }).sort({ order: 1, name: 1 }).lean());
  const asOf = asOfKey || asOfForYear(year, todayKey());
  const winStart = new Date(Date.UTC(year - 1, 0, 1));
  const winEnd = new Date(Date.UTC(year, 11, 31, 23, 59, 59));
  const reqs = await LeaveRequest.find({
    employeeId: employee._id,
    status: { $in: ['approved', 'pending'] },
    fromDate: { $lte: winEnd },
    toDate: { $gte: winStart },
  })
    .select('leaveTypeId fromDate toDate days status')
    .lean();

  // Only a leave crossing Dec→Jan needs the calendar to split its days.
  const crosses = reqs.some((r) => yearOf(toDayKey(r.fromDate)) !== yearOf(toDayKey(r.toDate)));
  const ctx = crosses
    ? await leaveDayContext(employee, new Date(Date.UTC(year - 2, 11, 1)), new Date(Date.UTC(year + 1, 0, 31)))
    : {};

  const joinKey = employee.dateOfJoining ? toDayKey(employee.dateOfJoining) : null;
  return typeList.map((t) => {
    let used = 0;
    let pending = 0;
    let lastYearUsed = 0;
    for (const r of reqs) {
      if (String(r.leaveTypeId || '') !== String(t._id)) continue;
      if (r.status === 'approved') {
        used += daysInYear(r, year, ctx);
        lastYearUsed += daysInYear(r, year - 1, ctx);
      } else {
        pending += daysInYear(r, year, ctx);
      }
    }
    const b = computeTypeBalance({ type: t, year, asOfKey: asOf, joinKey, used, pending, lastYearUsed });
    return {
      leaveTypeId: t._id,
      name: t.name,
      code: t.code || '',
      color: t.color,
      paid: t.paid,
      year,
      ...b,
    };
  });
}

const toObjectId = (v) => {
  try {
    return new mongoose.Types.ObjectId(String(v));
  } catch (_) {
    return null;
  }
};

/// Single-level approval chain: reporting manager → dept head → any manager.
/// Every leave goes to the leave desk (admin + hr role) — one step.
/// The role on the step only drives the engine's own notification (admins);
/// who may actually decide is enforced by isLeaveDesk().
function buildLeaveChain() {
  return [{ label: 'HR', approverRole: 'admin' }];
}

/// Tell the hr-role logins about a new leave request (admins are notified by
/// the approval engine through the chain step).
async function notifyLeaveDesk({ title, body, actor }) {
  try {
    const ids = await leaveDeskUserIds();
    if (!ids.length) return;
    await notify({
      recipients: ids,
      type: 'approval_requested',
      title,
      body,
      link: '/hr/leave',
      createdBy: actor || null,
      excludeUserId: actor || null,
    });
  } catch (err) {
    console.error('[Leave] HR notification failed:', err?.message || err);
  }
}

// ─── Leave types ──────────────────────────────────────────────────────────
// @route GET /api/leave/types
export const getLeaveTypes = async (_req, res) => {
  try {
    let list = await LeaveType.find({}).sort({ order: 1, name: 1 });
    if (!list || list.length === 0) {
      const defaults = [
        { name: 'Casual Leave', code: 'CL', annualQuota: 12, paid: true, carryForward: false, color: '#3B82F6', order: 1 },
        { name: 'Sick Leave', code: 'SL', annualQuota: 12, paid: true, carryForward: true, carryForwardMax: 6, color: '#EF4444', order: 2 },
        { name: 'Earned Leave', code: 'EL', annualQuota: 15, paid: true, carryForward: true, carryForwardMax: 15, color: '#10B981', order: 3 },
        { name: 'Unpaid Leave (LWP)', code: 'LWP', annualQuota: 0, paid: false, carryForward: false, color: '#6B7280', order: 4 },
      ];
      await LeaveType.insertMany(defaults);
      list = await LeaveType.find({}).sort({ order: 1, name: 1 });
    }
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// @desc  Whether the caller may edit leave types / holidays (HR-wide only), so
//        the app can show the Leave Types editor to the right people.
// @route GET /api/leave/types/access
export const getLeaveMasterAccess = async (req, res) => {
  try {
    // canDecide: may see everyone's leave requests and approve/reject them.
    res.json({ canEdit: await canEditLeaveMaster(req), canDecide: await isLeaveDesk(req) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// @route POST /api/leave/types
export const createLeaveType = async (req, res) => {
  try {
    if (!(await canEditLeaveMaster(req))) return res.status(403).json({ message: 'Not allowed' });
    const { name, code, annualQuota, paid, carryForward, carryForwardMax, docRequired, color, order, active } = req.body;
    if (!name) return res.status(400).json({ message: 'Name is required' });
    const t = await LeaveType.create({
      name,
      active: active !== false,
      code: code || '',
      annualQuota: Number(annualQuota) || 0,
      paid: paid !== false,
      carryForward: !!carryForward,
      carryForwardMax: Number(carryForwardMax) || 0,
      docRequired: docRequired || 'Not required',
      color: color || '#601A29',
      order: Number(order) || 0,
    });
    res.status(201).json(t);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// @route PUT /api/leave/types/:id
export const updateLeaveType = async (req, res) => {
  try {
    if (!(await canEditLeaveMaster(req))) return res.status(403).json({ message: 'Not allowed' });
    const t = await LeaveType.findById(req.params.id);
    if (!t) return res.status(404).json({ message: 'Leave type not found' });
    const fields = ['name', 'code', 'docRequired', 'color'];
    for (const f of fields) if (req.body[f] !== undefined) t[f] = req.body[f];
    if (req.body.annualQuota !== undefined) t.annualQuota = Number(req.body.annualQuota) || 0;
    if (req.body.paid !== undefined) t.paid = !!req.body.paid;
    if (req.body.carryForward !== undefined) t.carryForward = !!req.body.carryForward;
    if (req.body.carryForwardMax !== undefined) t.carryForwardMax = Number(req.body.carryForwardMax) || 0;
    if (req.body.order !== undefined) t.order = Number(req.body.order) || 0;
    if (req.body.active !== undefined) t.active = !!req.body.active;
    await t.save();
    res.json(t);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// @route DELETE /api/leave/types/:id
export const deleteLeaveType = async (req, res) => {
  try {
    if (!(await canEditLeaveMaster(req))) return res.status(403).json({ message: 'Not allowed' });
    const t = await LeaveType.findById(req.params.id);
    if (!t) return res.status(404).json({ message: 'Leave type not found' });
    await t.deleteOne();
    res.json({ message: 'Leave type deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// @desc  Seed the four standard leave types (idempotent).
// @route POST /api/leave/types/seed
export const seedLeaveTypes = async (req, res) => {
  try {
    if (!(await canEditLeaveMaster(req))) return res.status(403).json({ message: 'Not allowed' });
    const defaults = [
      { name: 'Casual', code: 'CL', annualQuota: 8, paid: true, order: 1 },
      { name: 'Sick', code: 'SL', annualQuota: 6, paid: true, docRequired: 'Certificate > 2 days', order: 2 },
      { name: 'Earned', code: 'EL', annualQuota: 15, paid: true, carryForward: true, carryForwardMax: 30, order: 3 },
      { name: 'Unpaid', code: 'LWP', annualQuota: 0, paid: false, order: 4 },
    ];
    let created = 0;
    for (const d of defaults) {
      const existing = await LeaveType.findOne({ name: d.name });
      if (!existing) {
        await LeaveType.create(d);
        created += 1;
      }
    }
    res.json({ message: `Seeded ${created} leave type(s)`, created });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── Leave requests ─────────────────────────────────────────────────────────
// @desc  Apply for leave (self, or HR on behalf). Routes through Approvals.
// @route POST /api/leave/apply
export const applyLeave = async (req, res) => {
  try {
    const { leaveTypeId, fromDate, toDate, halfDay, reason, documentUrl, useCompOffId } = req.body;

    let employeeId = req.user.employeeId;
    const onBehalf =
      req.body.employeeId && String(req.body.employeeId) !== String(req.user.employeeId || '');
    if (onBehalf) {
      if (!(await canManageLeaveFor(req, req.body.employeeId))) {
        return res.status(403).json({ message: 'Not allowed to file leave for others' });
      }
      employeeId = req.body.employeeId;
    }
    if (!employeeId) {
      return res.status(400).json({ message: 'No employee record is linked to your account.' });
    }
    const employee = await Employee.findById(employeeId);
    if (!employee) return res.status(404).json({ message: 'Employee not found' });

    if (!fromDate || !toDate) return res.status(400).json({ message: 'Select the leave dates.' });
    const from = parseDateMiddayUtc(fromDate);
    const to = parseDateMiddayUtc(toDate);
    if (!from || !to || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return res.status(400).json({ message: 'Enter valid dates.' });
    }
    if (to < from) return res.status(400).json({ message: 'End date cannot be before start date.' });

    let leaveType = leaveTypeId ? await LeaveType.findById(leaveTypeId) : null;
    if (!leaveType) {
      leaveType = await LeaveType.findOne({ active: { $ne: false } }).sort({ order: 1 });
    }

    // Days = calendar days − the department's weekly offs − holidays (no
    // sandwich rule). A single-day half-day is 0.5.
    // The app has sent 'first_half'/'second_half'; the model stores first/second.
    const HALF_ALIASES = { first_half: 'first', second_half: 'second' };
    const half = HALF_ALIASES[halfDay] || (['first', 'second'].includes(halfDay) ? halfDay : 'none');
    const ctx = await leaveDayContext(employee, from, to);
    const counted = countLeaveDays({ from, to, ...ctx, halfDay: half });
    const days = counted.days;
    if (days <= 0) {
      return res.status(400).json({ message: 'Those dates are all weekly offs/holidays — no leave is needed.' });
    }

    // No overlap with another pending/approved leave of the same employee
    // (two half-days on different halves of the same day are fine).
    const overlaps = await LeaveRequest.find({
      employeeId: employee._id,
      status: { $in: ['pending', 'approved'] },
      fromDate: { $lte: new Date(to.getTime() + DAY_MS / 2) },
      toDate: { $gte: new Date(from.getTime() - DAY_MS / 2) },
    })
      .select('fromDate toDate halfDay status')
      .lean();
    const fromKey = toDayKey(from);
    const toKey = toDayKey(to);
    const clash = overlaps.find((o) => {
      const ok = toDayKey(o.fromDate);
      const okEnd = toDayKey(o.toDate);
      if (okEnd < fromKey || ok > toKey) return false;
      const bothHalves =
        half !== 'none' && fromKey === toKey && ok === okEnd && (o.halfDay || 'none') !== 'none' && o.halfDay !== half;
      return !bothHalves;
    });
    if (clash) {
      return res.status(409).json({
        message: `These dates overlap an existing ${clash.status} leave (${toDayKey(clash.fromDate)} to ${toDayKey(clash.toDate)}).`,
      });
    }

    // A comp-off being spent covers the leave instead of the type's quota.
    let compOff = null;
    if (useCompOffId) {
      compOff = await CompOff.findOne({ _id: useCompOffId, employeeId: employee._id, status: 'available' }).lean();
      if (!compOff) return res.status(400).json({ message: 'That comp-off is not available.' });
    }

    // Balance check — paid types with a quota only (LWP / quota 0 skip it).
    // Each calendar year is checked against its own credit.
    if (!compOff && leaveType && leaveType.paid !== false && Number(leaveType.annualQuota) > 0) {
      for (const [y, need] of Object.entries(counted.byYear)) {
        const [bal] = await computeBalances(employee, Number(y), { types: [leaveType.toObject()] });
        if (bal && need > bal.available) {
          const multiYear = Object.keys(counted.byYear).length > 1;
          return res.status(400).json({
            message:
              `Not enough ${leaveType.name} balance${multiYear ? ` for ${y}` : ''}: ` +
              `${bal.available} day(s) available, this request needs ${need}.`,
            available: bal.available,
            requested: need,
          });
        }
      }
    }

    const lr = await LeaveRequest.create({
      employeeId: employee._id,
      employeeName: employee.name,
      department: employee.department || '',
      leaveTypeId: leaveType?._id || null,
      leaveTypeName: leaveType?.name || '',
      fromDate: from,
      toDate: to,
      days,
      halfDay: half,
      reason: reason || '',
      documentUrl: documentUrl || '',
      status: 'pending',
      month: from.getUTCMonth() + 1,
      year: from.getUTCFullYear(),
      compOffId: useCompOffId || null,
      createdBy: req.user?._id || null,
    });

    const chain = buildLeaveChain();
    const approval = await createApproval({
      module: 'leave',
      title: `Leave — ${employee.name}`,
      summary: leaveApprovalSummary({
        typeName: leaveType?.name, days, from, to, halfDay: half, reason,
      }),
      requesterEmployeeId: employee._id,
      requesterUserId: req.user?._id || null,
      subjectEmployeeId: employee._id,
      refModel: 'LeaveRequest',
      refId: lr._id,
      chain,
      link: '/hr/leave',
      createdBy: req.user?._id || null,
    });
    await notifyLeaveDesk({ title: approval.title, body: approval.summary, actor: req.user?._id });
    lr.approvalId = approval._id;
    await lr.save();

    const populated = await LeaveRequest.findById(lr._id).populate(empPopulate);
    res.status(201).json(populated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// @desc  The signed-in employee's own leave requests (ESS).
// @route GET /api/leave/mine
export const getMyLeave = async (req, res) => {
  try {
    if (!req.user.employeeId) return res.json([]);
    const { year } = req.query;
    const filter = { employeeId: req.user.employeeId, ...yearOverlapFilter(year) };
    const list = await LeaveRequest.find(filter).sort({ fromDate: -1 }).limit(200);
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// @desc  Team / org leave requests (managers, dept heads, HR).
// @route GET /api/leave/requests
export const getLeaveRequests = async (req, res) => {
  try {
    const { month, year, status, employeeId, department } = req.query;
    const filter = {};
    if (month && month !== 'all') {
      filter.month = Number(month);
      if (year && year !== 'all') filter.year = Number(year);
    } else {
      // A year view lists every leave touching that year, so a Dec→Jan leave
      // also shows in January's year (not only its start year).
      Object.assign(filter, yearOverlapFilter(year));
    }
    if (status && status !== 'all') filter.status = status;
    if (employeeId && employeeId !== 'all') filter.employeeId = employeeId;
    if (department && department !== 'all') filter.department = department;

    // Other people's leave: the leave desk (admin + hr role) sees everyone and
    // decides. A department head may SEE their own team's leave, read-only
    // (owner 2026-11-26); deciding stays with the desk (see decideLeave).
    let query = filter;
    if (!(await isLeaveDesk(req))) {
      if (req.user?.isDepartmentHead !== true) {
        return res.status(403).json({ message: 'Only HR or admin can view leave requests' });
      }
      query = await withLeaveScope(req, filter);
    }

    const list = await LeaveRequest.find(query)
      .populate(empPopulate)
      .sort({ fromDate: -1 })
      .limit(500);
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// @desc  Cancel a leave request.
//        Pending: the owner or a manager in scope.
//        Approved: the owner before the leave's start date, or a manager in
//        scope at any time (not on their own leave). Balances are computed, so
//        they restore automatically; a spent comp-off is released.
// @route POST /api/leave/:id/cancel
export const cancelLeave = async (req, res) => {
  try {
    const lr = await LeaveRequest.findById(req.params.id);
    if (!lr) return res.status(404).json({ message: 'Leave request not found' });
    const isOwner = !!req.user.employeeId && String(lr.employeeId) === String(req.user.employeeId);
    const isAdmin = String(req.user.role || '') === 'admin';
    // Manager rights never apply to one's own leave (the admin account excepted).
    const asManager = (!isOwner || isAdmin) && (await canManageLeaveFor(req, lr.employeeId));
    if (!isOwner && !asManager) return res.status(403).json({ message: 'Not allowed' });

    if (lr.status === 'approved') {
      const started = toDayKey(lr.fromDate) <= todayKey();
      if (!asManager && started) {
        return res.status(400).json({
          message: 'This leave has already started — ask your manager or HR to cancel it.',
        });
      }
    } else if (lr.status !== 'pending') {
      return res.status(400).json({ message: `This leave is already ${lr.status}.` });
    }

    const wasApproved = lr.status === 'approved';
    lr.status = 'cancelled';
    lr.cancelledBy = req.user._id || null;
    lr.cancelledAt = new Date();
    lr.cancelReason = String(req.body?.reason || '').trim();
    await lr.save();
    if (lr.approvalId) {
      await ApprovalRequest.updateOne(
        { _id: lr.approvalId, status: { $in: ['pending', 'approved'] } },
        { $set: { status: 'cancelled' } }
      );
    }
    // Give a spent comp-off back (or mark it expired if its window has passed).
    if (wasApproved && lr.compOffId) {
      const co = await CompOff.findOne({ _id: lr.compOffId, status: 'used' });
      if (co && (!co.usedInLeaveId || String(co.usedInLeaveId) === String(lr._id))) {
        co.status = co.expiresOn && co.expiresOn < new Date() ? 'expired' : 'available';
        co.usedInLeaveId = null;
        await co.save();
      }
    }
    // A Timebox leave cancelled in the CRM: tell Timebox (status "cancelled").
    // Skipped quietly until TIMEBOX_SEND_CANCEL=true (see leaveCallbackService).
    let callback = null;
    if (lr.callbackUrl && lr.externalRequestId != null) {
      callback = await dispatchLeaveCallback(lr, {
        approver: req.user?.name || 'HR',
        note: lr.cancelReason || 'Cancelled in Nizan CRM',
      }).catch((e) => ({ sent: false, error: e?.message || String(e) }));
    }
    const fresh = await LeaveRequest.findById(lr._id);
    res.json(callback ? { ...fresh.toObject(), callback } : fresh);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── Timebox: employee cancels in Timebox ──────────────────────────────────
// @route POST /api/leave/external-cancel  (CRM key, like external-request)
// Pending → cancelled any time. Approved → cancelled only before it starts;
// once started HR must cancel it in the CRM. No callback is sent back.
export const handleExternalLeaveCancel = async (req, res) => {
  try {
    const auth = verifyWebhookAuth(req);
    if (!auth.valid) return res.status(401).json({ ok: false, message: auth.reason || 'Unauthorized' });

    const { request_id, cancelled_by, reason } = req.body || {};
    const extReqId = Number(request_id);
    if (request_id == null || request_id === '' || !Number.isFinite(extReqId)) {
      return res.status(422).json({ ok: false, message: 'request_id is required' });
    }

    const lr = await LeaveRequest.findOne({ externalRequestId: extReqId });
    if (!lr) return res.status(404).json({ ok: false, message: 'Unknown request_id', request_id: extReqId });

    const previous = lr.status;
    if (previous === 'cancelled') {
      return res.json({ ok: true, request_id: extReqId, status: 'cancelled', previous_status: 'cancelled' });
    }
    if (previous === 'rejected') {
      return res.status(409).json({
        ok: false, request_id: extReqId, status: previous,
        message: 'This leave was rejected — there is nothing to cancel.',
      });
    }
    if (previous === 'approved' && toDayKey(lr.fromDate) <= todayKey()) {
      return res.status(409).json({
        ok: false, request_id: extReqId, status: previous,
        message: 'This leave has already started — HR must cancel it in the CRM.',
      });
    }

    const by = cancelled_by && typeof cancelled_by === 'object' ? cancelled_by : {};
    const byName = String(by.name || '').trim();
    lr.status = 'cancelled';
    lr.cancelledBy = null; // not a CRM user
    lr.cancelledAt = new Date();
    lr.cancelReason = [String(reason || '').trim(), byName ? `(cancelled in Timebox by ${byName})` : '(cancelled in Timebox)']
      .filter(Boolean)
      .join(' ');
    await lr.save();
    if (lr.approvalId) {
      await ApprovalRequest.updateOne(
        { _id: lr.approvalId, status: { $in: ['pending', 'approved'] } },
        { $set: { status: 'cancelled' } }
      );
    }
    if (previous === 'approved' && lr.compOffId) {
      const co = await CompOff.findOne({ _id: lr.compOffId, status: 'used' });
      if (co && (!co.usedInLeaveId || String(co.usedInLeaveId) === String(lr._id))) {
        co.status = co.expiresOn && co.expiresOn < new Date() ? 'expired' : 'available';
        co.usedInLeaveId = null;
        await co.save();
      }
    }
    console.log(`[Leave Webhook] Timebox cancelled request #${extReqId} (${previous} → cancelled)`);
    res.json({ ok: true, request_id: extReqId, status: 'cancelled', previous_status: previous });
  } catch (err) {
    console.error('[Leave Webhook] external-cancel failed:', err);
    res.status(500).json({ ok: false, message: err.message || 'Internal server error' });
  }
};

// ─── Timebox: holiday feed (CRM is the master list) ────────────────────────
// @route GET /api/leave/external-holidays?year=2026  (CRM key)
// Timebox replaces its holiday list for the year with this. Recurring
// holidays are given on their date in the requested year. Optional holidays
// are listed but do not count as days off (counts_as_holiday: false).
export const getExternalHolidays = async (req, res) => {
  try {
    const auth = verifyWebhookAuth(req);
    if (!auth.valid) return res.status(401).json({ ok: false, message: auth.reason || 'Unauthorized' });

    const year = Number(req.query.year) || yearOf(todayKey());
    if (year < 2000 || year > 2100) return res.status(422).json({ ok: false, message: 'year is invalid' });

    const rows = await Holiday.find({ $or: [{ year }, { recurring: true }] }).sort({ date: 1 }).lean();
    const out = [];
    const seen = new Set();
    let updatedAt = null;
    for (const h of rows) {
      const key = toDayKey(h.date);
      if (!key) continue;
      const date = h.recurring ? `${year}-${key.slice(5)}` : key;
      if (!date.startsWith(`${year}-`)) continue;
      const id = String(h._id);
      if (seen.has(id)) continue;
      seen.add(id);
      const u = h.updatedAt || h.createdAt;
      if (u && (!updatedAt || u > updatedAt)) updatedAt = u;
      out.push({
        id,
        date,
        name: h.name,
        type: h.type || 'national',
        counts_as_holiday: (h.type || 'national') !== 'optional',
        recurring: !!h.recurring,
      });
    }
    out.sort((a, b) => a.date.localeCompare(b.date));
    res.json({ ok: true, year, updated_at: updatedAt, count: out.length, holidays: out });
  } catch (err) {
    console.error('[Leave Webhook] external-holidays failed:', err);
    res.status(500).json({ ok: false, message: err.message || 'Internal server error' });
  }
};

// @desc  Leave balances per type for an employee (self or, for HR, anyone).
// @route GET /api/leave/balances
export const getBalances = async (req, res) => {
  try {
    const employeeId = req.query.employeeId || req.user.employeeId;
    if (!employeeId) return res.json([]);
    if (
      String(employeeId) !== String(req.user.employeeId || '') &&
      !(await canManageLeaveFor(req, employeeId))
    ) {
      return res.status(403).json({ message: 'Not allowed' });
    }
    const oid = toObjectId(employeeId);
    if (!oid) return res.status(400).json({ message: 'Invalid employee id' });
    const year = Number(req.query.year) || yearOf(todayKey());
    const employee = await Employee.findById(oid).select('department departmentId dateOfJoining').lean();
    if (!employee) return res.status(404).json({ message: 'Employee not found' });

    // { quota, credited, carriedForward, used, pending, available } per type,
    // plus the legacy `allocated`. Overdrawn balances come back negative.
    res.json(await computeBalances(employee, year));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── Holidays ────────────────────────────────────────────────────────────
// @route GET /api/leave/holidays
export const getHolidays = async (req, res) => {
  try {
    const { year } = req.query;
    const filter = {};
    if (year && year !== 'all') filter.year = Number(year);
    res.json(await Holiday.find(filter).sort({ date: 1 }));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// @route POST /api/leave/holidays
export const createHoliday = async (req, res) => {
  try {
    if (!(await canEditLeaveMaster(req))) return res.status(403).json({ message: 'Not allowed' });
    const { name, date, type, recurring, notes } = req.body;
    if (!name || !date) return res.status(400).json({ message: 'Name and date are required' });
    const d = new Date(date);
    if (Number.isNaN(d.getTime())) return res.status(400).json({ message: 'Enter a valid date.' });
    const h = await Holiday.create({
      name,
      date: d,
      year: d.getFullYear(),
      type: type || 'national',
      recurring: !!recurring,
      notes: notes || '',
      createdBy: req.user?._id || null,
    });
    res.status(201).json(h);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// @route DELETE /api/leave/holidays/:id
export const deleteHoliday = async (req, res) => {
  try {
    if (!(await canEditLeaveMaster(req))) return res.status(403).json({ message: 'Not allowed' });
    const h = await Holiday.findById(req.params.id);
    if (!h) return res.status(404).json({ message: 'Holiday not found' });
    await h.deleteOne();
    res.json({ message: 'Holiday deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── Compensatory off ──────────────────────────────────────────────────────
// @route GET /api/leave/comp-offs
export const getCompOffs = async (req, res) => {
  try {
    const filter = {};
    if (!(await isLeaveDesk(req))) {
      if (!req.user.employeeId) return res.json([]);
      filter.employeeId = req.user.employeeId;
    } else if (req.query.employeeId && req.query.employeeId !== 'all') {
      filter.employeeId = req.query.employeeId;
    }
    res.json(
      await CompOff.find(filter).populate({ path: 'employeeId', select: 'name department' }).sort({ createdAt: -1 })
    );
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// @desc  Grant a comp-off to an employee (HR / manager).
// @route POST /api/leave/comp-offs
export const createCompOff = async (req, res) => {
  try {
    if (!(await isLeaveDesk(req))) return res.status(403).json({ message: 'Only HR or admin can grant comp-offs' });
    const { employeeId, workedOn, reason, grantedDays, expiresOn } = req.body;
    if (!employeeId || !workedOn) {
      return res.status(400).json({ message: 'Employee and worked-on date are required' });
    }
    const employee = await Employee.findById(employeeId);
    if (!employee) return res.status(404).json({ message: 'Employee not found' });
    const worked = new Date(workedOn);
    if (Number.isNaN(worked.getTime())) return res.status(400).json({ message: 'Enter a valid date.' });
    const expires = expiresOn ? new Date(expiresOn) : new Date(worked.getTime() + 60 * 86400000);
    const c = await CompOff.create({
      employeeId: employee._id,
      employeeName: employee.name,
      workedOn: worked,
      reason: reason || '',
      grantedDays: Number(grantedDays) || 1,
      expiresOn: expires,
      status: 'available',
      createdBy: req.user?._id || null,
    });
    res.status(201).json(c);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── Payroll feed ──────────────────────────────────────────────────────────
// @desc  Approved leave days per employee for a month (paid/unpaid) — a read
//        source the payroll run can subtract. Timebox stays the raw attendance.
// @route GET /api/leave/payroll-feed?month=&year=
export const getLeavePayrollFeed = async (req, res) => {
  try {
    const month = Number(req.query.month);
    const year = Number(req.query.year);
    if (!month || !year) return res.status(400).json({ message: 'month and year are required' });
    // Was open to any signed-in user; now managers only, scoped to department.
    const desk = await isLeaveDesk(req);
    if (!desk && !canManageLeave(req.user)) return res.status(403).json({ message: 'Not allowed' });
    const feedFilter = { status: 'approved', month, year };
    const reqs = await LeaveRequest.find(desk ? feedFilter : await withLeaveScope(req, feedFilter)).populate({
      path: 'leaveTypeId',
      select: 'paid name',
    });
    const map = new Map();
    for (const r of reqs) {
      const k = String(r.employeeId);
      if (!map.has(k)) map.set(k, { employeeId: r.employeeId, paidDays: 0, unpaidDays: 0 });
      const entry = map.get(k);
      const paid = r.leaveTypeId ? r.leaveTypeId.paid : true;
      if (paid) entry.paidDays += r.days;
      else entry.unpaidDays += r.days;
    }
    res.json([...map.values()]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── External Webhook Integration (Timebox / PHP Portal) ───────────────────

/**
 * Validate incoming authentication header for the external webhook.
 * Supports:
 *   - Bearer <token> in Authorization header
 *   - X-API-Key: <token> header
 */
function verifyWebhookAuth(req) {
  const configuredKeys = [
    process.env.LEAVE_WEBHOOK_API_KEY,
  ].filter(Boolean);

  const authHeader = req.headers['authorization'] || '';
  const apiKeyHeader = req.headers['x-api-key'] || req.headers['x-apikey'] || '';

  let providedToken = '';
  if (authHeader.startsWith('Bearer ')) {
    providedToken = authHeader.slice(7).trim();
  } else if (authHeader.startsWith('bearer ')) {
    providedToken = authHeader.slice(7).trim();
  } else if (authHeader) {
    providedToken = authHeader.trim();
  } else if (apiKeyHeader) {
    providedToken = String(apiKeyHeader).trim();
  }

  if (!providedToken) {
    return { valid: false, reason: 'Missing Authorization header or X-API-Key' };
  }

  const isMatch = configuredKeys.some((k) => k && k === providedToken);
  if (!isMatch) {
    return { valid: false, reason: 'Invalid API key or Bearer token' };
  }

  return { valid: true, token: providedToken };
}

/**
 * @desc  External app submits an employee leave application into Nizan CRM.
 * @route POST /api/leave/external-request
 * @route POST /api/leave/webhook
 * @access External Webhook (Bearer token / X-API-Key)
 */
export const handleExternalLeaveRequest = async (req, res) => {
  try {
    // 1. Auth check
    const auth = verifyWebhookAuth(req);
    if (!auth.valid) {
      return res.status(401).json({
        ok: false,
        message: auth.reason || 'Unauthorized webhook request',
      });
    }

    const {
      request_id,
      employee,
      department_head,
      leave_type,
      start_date,
      end_date,
      working_days,
      reason,
      requested_at,
      callback_url,
    } = req.body || {};

    // 2. Validate mandatory fields
    if (request_id == null) {
      return res.status(422).json({
        ok: false,
        message: 'request_id is required',
      });
    }

    if (!start_date || !end_date) {
      return res.status(422).json({
        ok: false,
        message: 'start_date and end_date are required',
      });
    }

    const fromDate = new Date(start_date);
    const toDate = new Date(end_date);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      return res.status(422).json({
        ok: false,
        message: 'start_date or end_date is an invalid date string',
      });
    }

    if (toDate < fromDate) {
      return res.status(422).json({
        ok: false,
        message: 'end_date cannot be earlier than start_date',
      });
    }

    const extReqId = Number(request_id);

    // 3. Idempotency check: Safe to retry. If already exists, return 200 without duplicating
    const existing = await LeaveRequest.findOne({ externalRequestId: extReqId });
    if (existing) {
      return res.status(200).json({
        ok: true,
        id: existing._id,
        reference: String(existing._id),
        request_id: extReqId,
        status: existing.status,
        message: 'Leave request already exists in CRM (idempotent response)',
      });
    }

    // 4. Match or auto-provision Employee in CRM
    const empData = employee || {};
    const tbEmpId = empData.id != null ? Number(empData.id) : null;
    const empEmail = String(empData.email || '').trim().toLowerCase();
    const empName = String(empData.name || '').trim();

    let crmEmp = null;
    if (tbEmpId != null) {
      crmEmp = await Employee.findOne({ timeboxEmployeeId: tbEmpId });
    }
    if (!crmEmp && empEmail) {
      crmEmp = await Employee.findOne({ email: empEmail });
    }
    if (!crmEmp && empName) {
      crmEmp = await Employee.findOne({ name: new RegExp(`^${escapeRegex(empName)}$`, 'i') });
    }

    if (!crmEmp) {
      // HR deleted this person from the CRM: never re-create them (same rule
      // as the Timebox employee sync). Reply 409 and create nothing.
      const ignoredOr = [];
      if (tbEmpId != null && !Number.isNaN(tbEmpId)) ignoredOr.push({ timeboxEmployeeId: tbEmpId });
      if (empEmail) ignoredOr.push({ email: empEmail });
      const ignoredRow = ignoredOr.length
        ? await TimeboxIgnoredEmployee.findOne({ $or: ignoredOr }).select('_id').lean()
        : null;
      if (ignoredRow) {
        return res.status(409).json({
          ok: false,
          request_id: extReqId,
          message: 'This employee was removed from the CRM, so the leave request was not recorded.',
        });
      }
      // Auto-provision so external employee leaves are never lost
      crmEmp = await Employee.create({
        name: empName || `Employee #${tbEmpId || extReqId}`,
        email: empEmail || '',
        role: String(empData.designation || 'Staff').trim(),
        department: String(empData.department || 'Operations').trim(),
        timeboxEmployeeId: tbEmpId,
        timeboxName: empName || '',
        status: 'active',
        employmentStatus: 'confirmed',
        category: 'administrative',
        salaryType: 'fixed_monthly',
      });
      console.log(`[Leave Webhook] Auto-provisioned CRM Employee ${crmEmp.name} (id: ${crmEmp._id}) for Timebox ID: ${tbEmpId}`);
    } else {
      // Keep timeboxEmployeeId synced if missing
      if (tbEmpId != null && !crmEmp.timeboxEmployeeId) {
        crmEmp.timeboxEmployeeId = tbEmpId;
        if (empName && !crmEmp.timeboxName) crmEmp.timeboxName = empName;
        await crmEmp.save();
      }
    }

    // 5. Match LeaveType (Paid vs Unpaid)
    const isPaid = !/^unpaid/i.test(String(leave_type || 'paid').trim());
    let leaveTypeDoc = await LeaveType.findOne({ paid: isPaid, active: true }).sort({ order: 1, name: 1 });
    if (!leaveTypeDoc) {
      // Fallback to any active leave type
      leaveTypeDoc = await LeaveType.findOne({ active: true }).sort({ order: 1 });
    }

    // 6. Day count — same rule as an in-app apply (calendar days − weekly
    //    offs − holidays), but an external request is never rejected here.
    //    Timebox's working_days only signals a half day (0.5).
    const startKey = toDayKey(typeof start_date === 'string' ? start_date : fromDate);
    const endKey = toDayKey(typeof end_date === 'string' ? end_date : toDate);
    const extHalf = Number(working_days) === 0.5 && startKey === endKey ? 'first' : 'none';
    const extCtx = await leaveDayContext(crmEmp, fromDate, toDate);
    const days = countLeaveDays({ from: startKey, to: endKey, ...extCtx, halfDay: extHalf }).days;

    // 7. Timebox's `department_head` is kept in externalPayload for reference
    //    only — every leave is decided by the leave desk (admin + HR).

    // 8. Create LeaveRequest document
    const lr = await LeaveRequest.create({
      employeeId: crmEmp._id,
      employeeName: crmEmp.name,
      department: crmEmp.department || empData.department || '',
      leaveTypeId: leaveTypeDoc?._id || null,
      leaveTypeName: leaveTypeDoc?.name || (isPaid ? 'Paid Leave' : 'Unpaid Leave'),
      fromDate,
      toDate,
      days,
      halfDay: extHalf,
      reason: String(reason || 'External portal leave application').trim(),
      status: 'pending',
      month: fromDate.getMonth() + 1,
      year: fromDate.getFullYear(),
      externalRequestId: extReqId,
      callbackUrl: String(callback_url || '').trim(),
      externalSource: 'timebox',
      externalEmployeeId: tbEmpId,
      externalPayload: req.body,
      callbackStatus: 'none',
    });

    // 9. Route into CRM Approvals Engine
    const chain = buildLeaveChain();

    const approval = await createApproval({
      module: 'leave',
      title: `Leave — ${crmEmp.name}`,
      summary: leaveApprovalSummary({
        typeName: lr.leaveTypeName, days, from: startKey, to: endKey, halfDay: extHalf,
        reason, extra: `Timebox Req #${extReqId}`,
      }),
      requesterEmployeeId: crmEmp._id,
      subjectEmployeeId: crmEmp._id,
      refModel: 'LeaveRequest',
      refId: lr._id,
      chain,
      link: '/hr/leave',
    });

    lr.approvalId = approval._id;
    await lr.save();
    await notifyLeaveDesk({ title: approval.title, body: approval.summary });

    console.log(`[Leave Webhook] Successfully created LeaveRequest ${lr._id} for external request #${extReqId} (Employee: ${crmEmp.name})`);

    // 10. Return 201 response with reference ID
    res.status(201).json({
      ok: true,
      id: lr._id,
      reference: String(lr._id),
      request_id: extReqId,
      status: 'pending',
      message: 'Leave request received and queued for approval in Nizan CRM',
    });
  } catch (err) {
    console.error('[Leave Webhook] Error processing incoming leave request:', err);
    res.status(500).json({
      ok: false,
      message: err.message || 'Internal server error processing leave request',
    });
  }
};

/**
 * @desc  Directly approve or reject a leave request (HR / Admin), triggering callback.
 * @route POST /api/leave/:id/decide
 * @access Private (hr role / admin)
 */
export const decideLeaveDirectly = async (req, res) => {
  try {
    if (!(await isLeaveDesk(req))) {
      return res.status(403).json({ message: 'Only HR or admin can approve or reject leave' });
    }

    const { status, note } = req.body;
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'status must be "approved" or "rejected"' });
    }

    const lr = await LeaveRequest.findById(req.params.id);
    if (!lr) return res.status(404).json({ message: 'Leave request not found' });

    // Only a pending request can be decided — no flipping approved ↔ rejected.
    if (lr.status !== 'pending') {
      return res.status(409).json({ message: `This leave is already ${lr.status}.` });
    }
    // Nobody decides their own leave (the owner/admin account excepted).
    const ownEmp = req.user.employeeId ? String(req.user.employeeId) : '';
    if (String(req.user.role || '') !== 'admin' && ownEmp && String(lr.employeeId) === ownEmp) {
      return res.status(403).json({ message: 'You cannot decide your own leave request.' });
    }

    lr.status = status;
    lr.decidedBy = req.user._id;
    lr.decidedAt = new Date();
    lr.decisionNote = String(note || '').trim();
    await lr.save();

    // Sync linked approval request if present
    if (lr.approvalId) {
      await ApprovalRequest.updateOne(
        { _id: lr.approvalId },
        { $set: { status, decidedAt: new Date() } }
      );
    }

    // Release/spend comp-off if approved
    if (status === 'approved' && lr.compOffId) {
      await CompOff.updateOne(
        { _id: lr.compOffId },
        { $set: { status: 'used', usedInLeaveId: lr._id } }
      );
    }

    // Trigger external callback if linked
    let callbackResult = null;
    if (lr.callbackUrl && lr.externalRequestId != null) {
      callbackResult = await dispatchLeaveCallback(lr, {
        approver: req.user?.name || 'HR Department',
        note: lr.decisionNote,
      });
    }

    const populated = await LeaveRequest.findById(lr._id).populate(empPopulate);
    res.json({
      leaveRequest: populated,
      callback: callbackResult,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * @desc  Manually re-dispatch callback to external app (safe to retry).
 * @route POST /api/leave/:id/retry-callback
 * @access Private (HR/Admin)
 */
export const retryLeaveCallback = async (req, res) => {
  try {
    if (!(await isLeaveDesk(req))) {
      return res.status(403).json({ message: 'Only HR or admin can re-send leave callbacks' });
    }

    const lr = await LeaveRequest.findById(req.params.id);
    if (!lr) return res.status(404).json({ message: 'Leave request not found' });

    if (!lr.callbackUrl || lr.externalRequestId == null) {
      return res.status(400).json({
        message: 'This leave request is not linked to an external webhook callback',
      });
    }

    if (lr.status === 'pending') {
      return res.status(400).json({
        message: 'Cannot send callback for a pending request. Decide the request first.',
      });
    }

    const result = await dispatchLeaveCallback(lr, {
      approver: req.user?.name || 'HR Manager',
      note: lr.decisionNote,
    });

    if (result.skipped) {
      return res.status(400).json({ message: result.reason, result });
    }
    const updated = await LeaveRequest.findById(lr._id);
    res.json({
      message: result.sent ? 'Callback delivered successfully' : 'Callback dispatch failed',
      result,
      leaveRequest: updated,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

