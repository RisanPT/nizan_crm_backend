import asyncHandler from 'express-async-handler';
import TravelRequest from '../models/TravelRequest.js';
import Employee from '../models/Employee.js';
import ApprovalRequest from '../models/ApprovalRequest.js';
import { createApproval } from '../services/approvals.js';
import { buildEmployeeApprovalChain } from '../utils/approvalChain.js';
import { scopeFilter, assertEmployeeInScope } from '../utils/hrDeptScope.js';

// Dept heads only handle travel requests of their own department's staff.
const KEYS = ['travel'];

const empPopulate = { path: 'employeeId', select: 'name department profileImage' };

const canManage = (user) => {
  const role = String(user?.role || '').toLowerCase();
  if (role === 'admin' || role === 'manager' || role === 'hr') return true;
  if (user?.isDepartmentHead) return true;
  const perms = user?.permissions || [];
  return perms.includes('travel') || perms.includes('staff');
};

// The `hr` login role runs HR company-wide (like grievances / performance).
const isHrRole = (user) => String(user?.role || '').trim().toLowerCase() === 'hr';
const scopeFor = async (req) => (isHrRole(req.user) ? {} : scopeFilter(req, KEYS));
const assertInScope = async (req, res, employeeId) => {
  if (!isHrRole(req.user)) await assertEmployeeInScope(req, res, employeeId, KEYS);
};

const getMine = asyncHandler(async (req, res) => {
  const employeeId = req.user.employeeId;
  if (!employeeId) return res.json([]);
  const rows = await TravelRequest.find({ employeeId }).sort({ fromDate: -1, createdAt: -1 }).limit(100).lean();
  res.json(rows);
});

const getRequests = asyncHandler(async (req, res) => {
  if (!canManage(req.user)) { res.status(403); throw new Error('Not allowed'); }
  let filter = {};
  if (req.query.status && req.query.status !== 'all') filter.status = req.query.status;
  filter = { ...filter, ...(await scopeFor(req)) };
  const rows = await TravelRequest.find(filter).populate(empPopulate).sort({ fromDate: -1, createdAt: -1 }).limit(300);
  res.json(rows);
});

// @route POST /api/travel
const applyTravel = asyncHandler(async (req, res) => {
  let employeeId = req.user.employeeId;
  const onBehalf = req.body.employeeId && String(req.body.employeeId) !== String(employeeId || '');
  if (onBehalf) {
    if (!canManage(req.user)) { res.status(403); throw new Error('Not allowed to file for others'); }
    await assertInScope(req, res, req.body.employeeId);
    employeeId = req.body.employeeId;
  }
  if (!employeeId) { res.status(400); throw new Error('No employee record is linked to your account.'); }

  const destination = String(req.body.destination || '').trim();
  if (!destination) { res.status(400); throw new Error('Please add a destination'); }

  const employee = await Employee.findById(employeeId);
  if (!employee) { res.status(404); throw new Error('Employee not found'); }

  const fromDate = req.body.fromDate ? new Date(req.body.fromDate) : null;
  const toDate = req.body.toDate ? new Date(req.body.toDate) : null;
  if ((fromDate && Number.isNaN(fromDate.getTime())) || (toDate && Number.isNaN(toDate.getTime()))) {
    res.status(400);
    throw new Error('Invalid travel date');
  }
  if (fromDate && toDate && toDate < fromDate) {
    res.status(400);
    throw new Error('The return date cannot be before the start date');
  }
  const advanceRequested = Boolean(req.body.advanceRequested);
  const estimatedCost = Number(req.body.estimatedCost) || 0;
  const trip = await TravelRequest.create({
    employeeId: employee._id,
    employeeName: employee.name,
    department: employee.department || '',
    destination,
    purpose: String(req.body.purpose || '').trim(),
    mode: req.body.mode || 'flight',
    fromDate,
    toDate,
    estimatedCost,
    advanceRequested,
    // No advance asked for → no advance amount, whatever the form still held.
    advanceAmount: advanceRequested ? Number(req.body.advanceAmount) || 0 : 0,
    status: 'pending',
    createdBy: req.user?._id || null,
  });

  const chain = await buildEmployeeApprovalChain(employee);
  const approval = await createApproval({
    module: 'travel',
    title: `Travel — ${employee.name}`,
    summary: `${destination}${estimatedCost > 0 ? ` · ₹${estimatedCost.toFixed(0)}` : ''}`,
    requesterEmployeeId: employee._id,
    requesterUserId: req.user?._id || null,
    subjectEmployeeId: employee._id,
    refModel: 'TravelRequest',
    refId: trip._id,
    amount: estimatedCost,
    chain,
    link: '/hr/approvals',
    createdBy: req.user?._id || null,
  });
  trip.approvalId = approval._id;
  await trip.save();

  const populated = await TravelRequest.findById(trip._id).populate(empPopulate);
  res.status(201).json(populated);
});

// @route POST /api/travel/:id/cancel  — own pending only
const cancelTravel = asyncHandler(async (req, res) => {
  const trip = await TravelRequest.findById(req.params.id);
  if (!trip) { res.status(404); throw new Error('Request not found'); }
  const owns = String(trip.employeeId) === String(req.user.employeeId || '');
  if (!owns && !canManage(req.user)) { res.status(403); throw new Error('Not allowed'); }
  if (!owns) await assertInScope(req, res, trip.employeeId);
  if (trip.status !== 'pending') { res.status(409); throw new Error('Only a pending request can be cancelled'); }
  trip.status = 'cancelled';
  await trip.save();
  if (trip.approvalId) {
    await ApprovalRequest.updateOne({ _id: trip.approvalId, status: 'pending' }, { $set: { status: 'cancelled' } });
  }
  res.json({ message: 'Request cancelled', id: req.params.id });
});

export { getMine, getRequests, applyTravel, cancelTravel };
