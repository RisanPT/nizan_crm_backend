import asyncHandler from 'express-async-handler';
import ExpenseClaim, { CLAIM_CATEGORIES } from '../models/ExpenseClaim.js';
import Employee from '../models/Employee.js';
import ApprovalRequest from '../models/ApprovalRequest.js';
import { createApproval } from '../services/approvals.js';
import { buildEmployeeApprovalChain } from '../utils/approvalChain.js';
import { postDoc, unpostDoc, safePost } from '../services/posting.js';
import { scopeFilter, assertEmployeeInScope } from '../utils/hrDeptScope.js';

// Dept heads only handle claims of their own department's staff.
const KEYS = ['reimbursement'];

const empPopulate = { path: 'employeeId', select: 'name department profileImage' };

const canManage = (user) => {
  const role = String(user?.role || '').toLowerCase();
  if (role === 'admin' || role === 'manager' || role === 'hr') return true;
  if (user?.isDepartmentHead) return true;
  const perms = user?.permissions || [];
  return perms.includes('reimbursement') || perms.includes('staff');
};

// Paying a claim posts money to the ledger: Finance / HR / admin only
// (2026-11-26 — department heads used to be able to mark their team paid).
const PAY_ROLES = ['admin', 'manager', 'hr', 'accounts', 'finance_head'];
const canPay = (user) => {
  if (PAY_ROLES.includes(String(user?.role || '').trim().toLowerCase())) return true;
  const perms = user?.permissions || [];
  return perms.includes('staff') || perms.includes('reimbursement') || perms.includes('payables');
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
  const rows = await ExpenseClaim.find({ employeeId }).sort({ date: -1 }).limit(100).lean();
  res.json(rows);
});

const getRequests = asyncHandler(async (req, res) => {
  if (!canManage(req.user)) { res.status(403); throw new Error('Not allowed'); }
  let filter = {};
  if (req.query.status && req.query.status !== 'all') filter.status = req.query.status;
  filter = { ...filter, ...(await scopeFor(req)) };
  const rows = await ExpenseClaim.find(filter).populate(empPopulate).sort({ date: -1 }).limit(300);
  res.json(rows);
});

// @route POST /api/reimbursements  — submit a claim (goes straight to approval)
const submitClaim = asyncHandler(async (req, res) => {
  let employeeId = req.user.employeeId;
  const onBehalf = req.body.employeeId && String(req.body.employeeId) !== String(employeeId || '');
  if (onBehalf) {
    if (!canManage(req.user)) { res.status(403); throw new Error('Not allowed to file for others'); }
    await assertInScope(req, res, req.body.employeeId);
    employeeId = req.body.employeeId;
  }
  if (!employeeId) { res.status(400); throw new Error('No employee record is linked to your account.'); }

  const title = String(req.body.title || '').trim();
  const amount = Number(req.body.amount) || 0;
  if (!title) { res.status(400); throw new Error('Please add a title'); }
  if (amount <= 0) { res.status(400); throw new Error('Amount must be greater than zero'); }

  const employee = await Employee.findById(employeeId);
  if (!employee) { res.status(404); throw new Error('Employee not found'); }

  const category = req.body.category || 'other';
  if (!CLAIM_CATEGORIES.includes(category)) {
    res.status(400);
    throw new Error(`Category must be one of: ${CLAIM_CATEGORIES.join(', ')}`);
  }
  const date = req.body.date ? new Date(req.body.date) : new Date();
  if (Number.isNaN(date.getTime())) { res.status(400); throw new Error('Invalid expense date'); }
  const claim = await ExpenseClaim.create({
    employeeId: employee._id,
    employeeName: employee.name,
    department: employee.department || '',
    category,
    title,
    amount,
    date,
    description: String(req.body.description || '').trim(),
    receiptUrl: String(req.body.receiptUrl || '').trim(),
    status: 'pending',
    month: date.getMonth() + 1,
    year: date.getFullYear(),
    createdBy: req.user?._id || null,
  });

  const chain = await buildEmployeeApprovalChain(employee);
  const approval = await createApproval({
    module: 'reimbursement',
    title: `Reimbursement — ${employee.name}`,
    summary: `${claim.title} · ₹${amount.toFixed(0)}`,
    requesterEmployeeId: employee._id,
    requesterUserId: req.user?._id || null,
    subjectEmployeeId: employee._id,
    refModel: 'ExpenseClaim',
    refId: claim._id,
    amount,
    chain,
    link: '/hr/approvals',
    createdBy: req.user?._id || null,
  });
  claim.approvalId = approval._id;
  await claim.save();

  const populated = await ExpenseClaim.findById(claim._id).populate(empPopulate);
  res.status(201).json(populated);
});

// @route POST /api/reimbursements/:id/cancel  — own pending only
const cancelClaim = asyncHandler(async (req, res) => {
  const claim = await ExpenseClaim.findById(req.params.id);
  if (!claim) { res.status(404); throw new Error('Claim not found'); }
  const owns = String(claim.employeeId) === String(req.user.employeeId || '');
  if (!owns && !canManage(req.user)) { res.status(403); throw new Error('Not allowed'); }
  if (!owns) await assertInScope(req, res, claim.employeeId);
  if (claim.status !== 'pending') { res.status(409); throw new Error('Only a pending claim can be cancelled'); }
  claim.status = 'cancelled';
  await claim.save();
  if (claim.approvalId) {
    await ApprovalRequest.updateOne({ _id: claim.approvalId, status: 'pending' }, { $set: { status: 'cancelled' } });
  }
  res.json({ message: 'Claim cancelled', id: req.params.id });
});

// @route POST /api/reimbursements/:id/pay  — HR marks an approved claim paid +
// posts the payment voucher to the ledger (best-effort).
const payClaim = asyncHandler(async (req, res) => {
  if (!canPay(req.user)) { res.status(403); throw new Error('Only Finance or HR can pay claims'); }
  const claim = await ExpenseClaim.findById(req.params.id);
  if (!claim) { res.status(404); throw new Error('Claim not found'); }
  // Separation of duties: nobody but the admin may pay out their own claim.
  const ownClaim = req.user.employeeId && String(claim.employeeId) === String(req.user.employeeId);
  if (ownClaim && String(req.user.role || '').toLowerCase() !== 'admin') {
    res.status(403);
    throw new Error('You cannot mark your own claim as paid');
  }
  if (claim.status !== 'approved') { res.status(409); throw new Error('Only an approved claim can be paid'); }
  claim.status = 'paid';
  claim.paidAt = new Date();
  claim.paymentMethod = req.body.paymentMethod === 'cash' ? 'cash' : 'bank';
  await claim.save();
  await safePost(() => postDoc('ExpenseClaim', claim.toObject(), req.user?._id || null));
  res.json(claim);
});

// @route DELETE /api/reimbursements/:id  — HR removes a claim (and its voucher)
const deleteClaim = asyncHandler(async (req, res) => {
  if (!canManage(req.user)) { res.status(403); throw new Error('Not allowed'); }
  const claim = await ExpenseClaim.findById(req.params.id);
  if (!claim) { res.status(404); throw new Error('Claim not found'); }
  await assertInScope(req, res, claim.employeeId);
  // A paid claim has a posted payment voucher; deleting it would silently
  // reverse money already paid out, so it must stay on record.
  if (claim.status === 'paid') { res.status(400); throw new Error('A paid claim cannot be deleted'); }
  await claim.deleteOne();
  await safePost(() => unpostDoc('ExpenseClaim', claim._id));
  if (claim.approvalId) {
    await ApprovalRequest.updateOne({ _id: claim.approvalId, status: 'pending' }, { $set: { status: 'cancelled' } });
  }
  res.json({ message: 'Claim removed', id: req.params.id });
});

export { getMine, getRequests, submitClaim, cancelClaim, payClaim, deleteClaim };
