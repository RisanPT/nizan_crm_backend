import mongoose from 'mongoose';
import LeaveType from '../models/LeaveType.js';
import LeaveRequest from '../models/LeaveRequest.js';
import Holiday from '../models/Holiday.js';
import CompOff from '../models/CompOff.js';
import Employee from '../models/Employee.js';
import User from '../models/User.js';
import ApprovalRequest from '../models/ApprovalRequest.js';
import { createApproval } from '../services/approvals.js';

const empPopulate = { path: 'employeeId', select: 'name department profileImage' };

/// HR / admin / dept-head / anyone granted the `leave` or `staff` feature may
/// manage leave for others. Plain employees can only act on their own records.
const canManageLeave = (user) => {
  const role = String(user?.role || '');
  if (role === 'admin' || role === 'manager') return true;
  if (user?.isDepartmentHead) return true;
  const perms = Array.isArray(user?.permissions) ? user.permissions : [];
  return perms.some((p) => p === 'leave' || p === 'staff' || String(p).startsWith('leave.') || String(p).startsWith('staff.'));
};

const dayDiffInclusive = (from, to) =>
  Math.round((to.setHours(0, 0, 0, 0) - from.setHours(0, 0, 0, 0)) / 86400000) + 1;

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
    res.json(await LeaveType.find({}).sort({ order: 1, name: 1 }));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// @route POST /api/leave/types
export const createLeaveType = async (req, res) => {
  try {
    if (!canManageLeave(req.user)) return res.status(403).json({ message: 'Not allowed' });
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
    if (!canManageLeave(req.user)) return res.status(403).json({ message: 'Not allowed' });
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
    if (!canManageLeave(req.user)) return res.status(403).json({ message: 'Not allowed' });
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
    if (!canManageLeave(req.user)) return res.status(403).json({ message: 'Not allowed' });
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
      if (!canManageLeave(req.user)) {
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
    const from = new Date(fromDate);
    const to = new Date(toDate);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return res.status(400).json({ message: 'Enter valid dates.' });
    }
    if (to < from) return res.status(400).json({ message: 'End date cannot be before start date.' });

    const fromKeep = new Date(from);
    let days = dayDiffInclusive(new Date(from), new Date(to));
    if ((halfDay || 'none') !== 'none' && days === 1) days = 0.5;

    const leaveType = leaveTypeId ? await LeaveType.findById(leaveTypeId) : null;

    const lr = await LeaveRequest.create({
      employeeId: employee._id,
      employeeName: employee.name,
      department: employee.department || '',
      leaveTypeId: leaveType?._id || null,
      leaveTypeName: leaveType?.name || '',
      fromDate: fromKeep,
      toDate: to,
      days,
      halfDay: halfDay || 'none',
      reason: reason || '',
      documentUrl: documentUrl || '',
      status: 'pending',
      month: fromKeep.getMonth() + 1,
      year: fromKeep.getFullYear(),
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

    if (!canManageLeave(req.user)) {
      if (req.user.isDepartmentHead && req.user.departmentId) {
        const emps = await Employee.find({ departmentId: req.user.departmentId }).select('_id');
        filter.employeeId = { $in: emps.map((e) => e._id) };
      } else {
        return res.status(403).json({ message: 'Not allowed' });
      }
    }

    const list = await LeaveRequest.find(filter)
      .populate(empPopulate)
      .sort({ fromDate: -1 })
      .limit(500);
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// @desc  Cancel a pending leave request (owner or HR).
// @route POST /api/leave/:id/cancel
export const cancelLeave = async (req, res) => {
  try {
    const lr = await LeaveRequest.findById(req.params.id);
    if (!lr) return res.status(404).json({ message: 'Leave request not found' });
    const isOwner = req.user.employeeId && String(lr.employeeId) === String(req.user.employeeId);
    if (!isOwner && !canManageLeave(req.user)) {
      return res.status(403).json({ message: 'Not allowed' });
    }
    if (lr.status !== 'pending') {
      return res.status(400).json({ message: 'Only a pending request can be cancelled.' });
    }
    lr.status = 'cancelled';
    await lr.save();
    if (lr.approvalId) {
      await ApprovalRequest.updateOne(
        { _id: lr.approvalId, status: 'pending' },
        { $set: { status: 'cancelled' } }
      );
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
      !canManageLeave(req.user)
    ) {
      return res.status(403).json({ message: 'Not allowed' });
    }
    const oid = toObjectId(employeeId);
    if (!oid) return res.status(400).json({ message: 'Invalid employee id' });
    const year = Number(req.query.year) || new Date().getFullYear();

    const types = await LeaveType.find({ active: true }).sort({ order: 1, name: 1 });
    const used = await LeaveRequest.aggregate([
      { $match: { employeeId: oid, status: 'approved', year } },
      { $group: { _id: '$leaveTypeId', used: { $sum: '$days' } } },
    ]);
    const usedMap = new Map(used.map((u) => [String(u._id), u.used]));

    res.json(
      types.map((t) => {
        const u = usedMap.get(String(t._id)) || 0;
        return {
          leaveTypeId: t._id,
          name: t.name,
          color: t.color,
          paid: t.paid,
          allocated: t.annualQuota,
          used: u,
          available: Math.max(0, t.annualQuota - u),
        };
      })
    );
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
    if (!canManageLeave(req.user)) return res.status(403).json({ message: 'Not allowed' });
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
    if (!canManageLeave(req.user)) return res.status(403).json({ message: 'Not allowed' });
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
    if (!canManageLeave(req.user)) return res.status(403).json({ message: 'Not allowed' });
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
    const reqs = await LeaveRequest.find({ status: 'approved', month, year }).populate({
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
