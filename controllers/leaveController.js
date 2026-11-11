import mongoose from 'mongoose';
import LeaveType from '../models/LeaveType.js';
import LeaveRequest from '../models/LeaveRequest.js';
import Holiday from '../models/Holiday.js';
import CompOff from '../models/CompOff.js';
import Employee from '../models/Employee.js';
import User from '../models/User.js';
import ApprovalRequest from '../models/ApprovalRequest.js';
import { createApproval } from '../services/approvals.js';
import { dispatchLeaveCallback } from '../services/leaveCallbackService.js';
import Department from '../models/Department.js';
import { scopeFilter, canManageEmployee, isHrWide } from '../utils/hrDeptScope.js';
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

/// Admin / manager / dept-head / anyone granted the `staff` module may manage
/// leave for others. NOT the plain `leave` key — that is the self-service key
/// every employee and artist has, so it must never unlock others' leave.
const canManageLeave = (user) => {
  const role = String(user?.role || '');
  if (role === 'admin' || role === 'manager') return true;
  if (user?.isDepartmentHead) return true;
  const perms = Array.isArray(user?.permissions) ? user.permissions : [];
  return perms.some((p) => p === 'staff' || String(p).startsWith('staff.'));
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

/// Manager AND the target employee is in their department (HR-wide: anyone).
const canManageLeaveFor = async (req, employeeId) =>
  canManageLeave(req.user) && canManageEmployee(req, employeeId, LEAVE_KEYS);

/// Leave types / holidays are company master data — HR-wide only.
const canEditLeaveMaster = async (req) => canManageLeave(req.user) && isHrWide(req, LEAVE_KEYS);

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
async function buildLeaveChain(employee) {
  let approverUserId = null;
  if (employee.reportingManagerId) {
    const mgr = await User.findOne({
      employeeId: employee.reportingManagerId,
      active: { $ne: false },
    }).select('_id');
    if (mgr) approverUserId = mgr._id;
  }
  if (!approverUserId && employee.departmentId) {
    const head = await User.findOne({
      departmentId: employee.departmentId,
      isDepartmentHead: true,
      active: { $ne: false },
    }).select('_id');
    if (head) approverUserId = head._id;
  }
  if (approverUserId) return [{ label: 'Reporting manager', approverUserId }];
  return [{ label: 'Manager', approverRole: 'manager' }];
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
    res.json({ canEdit: await canEditLeaveMaster(req) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// @route POST /api/leave/types
export const createLeaveType = async (req, res) => {
  try {
    if (!(await canEditLeaveMaster(req))) return res.status(403).json({ message: 'Not allowed' });
    const { name, code, annualQuota, paid, carryForward, carryForwardMax, docRequired, color, order } = req.body;
    if (!name) return res.status(400).json({ message: 'Name is required' });
    const t = await LeaveType.create({
      name,
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

    const chain = await buildLeaveChain(employee);
    const approval = await createApproval({
      module: 'leave',
      title: `Leave — ${employee.name}`,
      summary: `${leaveType?.name || 'Leave'} · ${days} day(s)`,
      requesterEmployeeId: employee._id,
      requesterUserId: req.user?._id || null,
      subjectEmployeeId: employee._id,
      refModel: 'LeaveRequest',
      refId: lr._id,
      chain,
      link: '/hr/approvals',
      createdBy: req.user?._id || null,
    });
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
    const filter = { employeeId: req.user.employeeId };
    if (year && year !== 'all') filter.year = Number(year);
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
    if (month && month !== 'all') filter.month = Number(month);
    if (year && year !== 'all') filter.year = Number(year);
    if (status && status !== 'all') filter.status = status;
    if (employeeId && employeeId !== 'all') filter.employeeId = employeeId;
    if (department && department !== 'all') filter.department = department;

    if (!canManageLeave(req.user)) return res.status(403).json({ message: 'Not allowed' });

    // Dept heads see only their own department's requests.
    const list = await LeaveRequest.find(await withLeaveScope(req, filter))
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
    res.json(lr);
  } catch (err) {
    res.status(500).json({ message: err.message });
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
    if (!canManageLeave(req.user)) {
      if (!req.user.employeeId) return res.json([]);
      filter.employeeId = req.user.employeeId;
    } else if (req.query.employeeId && req.query.employeeId !== 'all') {
      filter.employeeId = req.query.employeeId;
    }
    // Managers are limited to their department (self-service already is own id).
    const scoped = canManageLeave(req.user) ? await withLeaveScope(req, filter) : filter;
    res.json(
      await CompOff.find(scoped).populate({ path: 'employeeId', select: 'name department' }).sort({ createdAt: -1 })
    );
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// @desc  Grant a comp-off to an employee (HR / manager).
// @route POST /api/leave/comp-offs
export const createCompOff = async (req, res) => {
  try {
    if (!canManageLeave(req.user)) return res.status(403).json({ message: 'Not allowed' });
    const { employeeId, workedOn, reason, grantedDays, expiresOn } = req.body;
    if (!employeeId || !workedOn) {
      return res.status(400).json({ message: 'Employee and worked-on date are required' });
    }
    // Dept heads may only grant comp-offs inside their own department.
    if (!(await canManageEmployee(req, employeeId, LEAVE_KEYS))) {
      return res.status(403).json({ message: 'This employee is not in your department' });
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
    if (!canManageLeave(req.user)) return res.status(403).json({ message: 'Not allowed' });
    const reqs = await LeaveRequest.find(await withLeaveScope(req, { status: 'approved', month, year })).populate({
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
      crmEmp = await Employee.findOne({ name: new RegExp(`^${empName}$`, 'i') });
    }

    if (!crmEmp) {
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

    // 7. Configure Department Head Approver if provided
    let designatedApproverUserId = null;
    if (department_head && (department_head.email || department_head.name)) {
      const deptHeadEmail = String(department_head.email || '').trim().toLowerCase();
      if (deptHeadEmail) {
        const headUser = await User.findOne({ email: deptHeadEmail, active: { $ne: false } }).select('_id');
        if (headUser) designatedApproverUserId = headUser._id;
      }
    }

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
    const chain = designatedApproverUserId
      ? [{ label: 'Department Head', approverUserId: designatedApproverUserId }]
      : await buildLeaveChain(crmEmp);

    const approval = await createApproval({
      module: 'leave',
      title: `Leave — ${crmEmp.name}`,
      summary: `${lr.leaveTypeName} · ${days} day(s) · External Req #${extReqId}`,
      requesterEmployeeId: crmEmp._id,
      subjectEmployeeId: crmEmp._id,
      refModel: 'LeaveRequest',
      refId: lr._id,
      chain,
      link: '/hr/approvals',
    });

    lr.approvalId = approval._id;
    await lr.save();

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
 * @desc  Directly approve or reject a leave request (HR / Manager), triggering callback.
 * @route POST /api/leave/:id/decide
 * @access Private (HR/Admin/Manager)
 */
export const decideLeaveDirectly = async (req, res) => {
  try {
    if (!canManageLeave(req.user)) {
      return res.status(403).json({ message: 'Not authorized to decide leave requests' });
    }

    const { status, note } = req.body;
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'status must be "approved" or "rejected"' });
    }

    const lr = await LeaveRequest.findById(req.params.id);
    if (!lr) return res.status(404).json({ message: 'Leave request not found' });
    if (!(await canManageEmployee(req, lr.employeeId, LEAVE_KEYS))) {
      return res.status(403).json({ message: 'This employee is not in your department' });
    }

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
    if (!canManageLeave(req.user)) {
      return res.status(403).json({ message: 'Not allowed' });
    }

    const lr = await LeaveRequest.findById(req.params.id);
    if (!lr) return res.status(404).json({ message: 'Leave request not found' });
    if (!(await canManageEmployee(req, lr.employeeId, LEAVE_KEYS))) {
      return res.status(403).json({ message: 'This employee is not in your department' });
    }

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

