import asyncHandler from 'express-async-handler';
import mongoose from 'mongoose';
import EmployeeAsset, { EMPLOYEE_ASSET_CATEGORIES, EMPLOYEE_ASSET_STATUSES } from '../models/EmployeeAsset.js';
import Employee from '../models/Employee.js';
import { getHrScope, scopeFilter, canManageEmployee, isHrWide } from '../utils/hrDeptScope.js';

// Employee assets (laptop / phone / kit / uniform / ID card / SIM…).
//   • HR-wide (admin/manager, 'staff' module, head of HR): every employee.
//   • Department heads: their own department's staff (hrDeptScope).
//   • Everyone else: read-only view of their OWN issued items.
// Deleting a record is HR-wide only (returned/lost is the normal way to close it).
const KEYS = ['staff'];

const ownEmployeeId = (user) => (user?.employeeId ? String(user.employeeId) : '');
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ''));
const str = (v) => String(v ?? '').trim();
const dateOrNull = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const cleanCategory = (v) => (EMPLOYEE_ASSET_CATEGORIES.includes(str(v)) ? str(v) : 'other');

const loadInScope = async (req, res) => {
  if (!isId(req.params.id)) { res.status(404); throw new Error('Asset not found'); }
  const row = await EmployeeAsset.findById(req.params.id);
  if (!row) { res.status(404); throw new Error('Asset not found'); }
  if (!(await canManageEmployee(req, row.employeeId, KEYS))) {
    res.status(403);
    throw new Error('This employee is not in your department');
  }
  return row;
};

// @route GET /api/employee-assets?employeeId=&status=
const getEmployeeAssets = asyncHandler(async (req, res) => {
  const scope = await getHrScope(req, KEYS);
  const me = ownEmployeeId(req.user);
  const filter = {};
  const status = str(req.query.status);
  if (status && status !== 'all' && EMPLOYEE_ASSET_STATUSES.includes(status)) filter.status = status;
  const wanted = str(req.query.employeeId);
  if (wanted && !isId(wanted)) return res.json([]);

  if (scope.wide) {
    if (wanted) filter.employeeId = wanted;
  } else if (!scope.none) {
    // Department head: own department's staff, plus their own items.
    if (wanted) {
      if (wanted !== me && !scope.employeeIds.includes(wanted)) return res.json([]);
      filter.employeeId = wanted;
    } else {
      const sf = await scopeFilter(req, KEYS);
      const ids = [...(sf.employeeId?.$in || [])];
      if (me) ids.push(me);
      filter.employeeId = { $in: ids };
    }
  } else {
    // Plain employee: only their own.
    if (!me || (wanted && wanted !== me)) return res.json([]);
    filter.employeeId = me;
  }

  const rows = await EmployeeAsset.find(filter).sort({ status: 1, issuedOn: -1 }).limit(1000).lean();
  res.json(rows);
});

// @route POST /api/employee-assets
const issueEmployeeAsset = asyncHandler(async (req, res) => {
  const b = req.body || {};
  const employeeId = str(b.employeeId);
  const item = str(b.item);
  if (!employeeId || !isId(employeeId)) { res.status(400); throw new Error('An employee is required'); }
  if (!item) { res.status(400); throw new Error('Please describe the item'); }
  const employee = await Employee.findById(employeeId).select('name department');
  if (!employee) { res.status(404); throw new Error('Employee not found'); }
  if (!(await canManageEmployee(req, employee._id, KEYS))) {
    res.status(403);
    throw new Error('This employee is not in your department');
  }

  const row = await EmployeeAsset.create({
    employeeId: employee._id,
    employeeName: employee.name || '',
    department: employee.department || '',
    item,
    category: cleanCategory(b.category),
    serialNo: str(b.serialNo),
    issuedOn: dateOrNull(b.issuedOn) || new Date(),
    issuedBy: req.user?._id || null,
    issuedByName: req.user?.name || '',
    condition: str(b.condition),
    notes: str(b.notes),
    status: 'issued',
  });
  res.status(201).json(row);
});

// @route PUT /api/employee-assets/:id   (descriptive fields only)
const updateEmployeeAsset = asyncHandler(async (req, res) => {
  const row = await loadInScope(req, res);
  const b = req.body || {};
  if (b.item !== undefined) {
    if (!str(b.item)) { res.status(400); throw new Error('Please describe the item'); }
    row.item = str(b.item);
  }
  if (b.category !== undefined) row.category = cleanCategory(b.category);
  if (b.serialNo !== undefined) row.serialNo = str(b.serialNo);
  if (b.issuedOn !== undefined) row.issuedOn = dateOrNull(b.issuedOn) || row.issuedOn;
  if (b.condition !== undefined) row.condition = str(b.condition);
  if (b.returnCondition !== undefined) row.returnCondition = str(b.returnCondition);
  if (b.notes !== undefined) row.notes = str(b.notes);
  await row.save();
  res.json(row);
});

// @route POST /api/employee-assets/:id/return  { returnedOn?, returnCondition?, notes? }
const returnEmployeeAsset = asyncHandler(async (req, res) => {
  const row = await loadInScope(req, res);
  if (row.status === 'returned') { res.status(400); throw new Error('This item is already marked returned'); }
  const b = req.body || {};
  row.status = 'returned';
  row.returnedOn = dateOrNull(b.returnedOn) || new Date();
  row.returnedTo = req.user?._id || null;
  row.returnedToName = req.user?.name || '';
  if (b.returnCondition !== undefined) row.returnCondition = str(b.returnCondition);
  if (b.notes !== undefined && str(b.notes)) row.notes = str(b.notes);
  await row.save();
  res.json(row);
});

// @route POST /api/employee-assets/:id/lost  { notes? }
const markEmployeeAssetLost = asyncHandler(async (req, res) => {
  const row = await loadInScope(req, res);
  if (row.status !== 'issued') { res.status(400); throw new Error('Only an issued item can be marked lost'); }
  const b = req.body || {};
  row.status = 'lost';
  if (b.notes !== undefined && str(b.notes)) row.notes = str(b.notes);
  await row.save();
  res.json(row);
});

// @route DELETE /api/employee-assets/:id   (HR-wide only)
const deleteEmployeeAsset = asyncHandler(async (req, res) => {
  if (!(await isHrWide(req, KEYS))) {
    res.status(403);
    throw new Error('Only HR can delete asset records');
  }
  if (!isId(req.params.id)) { res.status(404); throw new Error('Asset not found'); }
  const row = await EmployeeAsset.findById(req.params.id);
  if (!row) { res.status(404); throw new Error('Asset not found'); }
  await row.deleteOne();
  res.json({ message: 'Asset record removed', id: req.params.id });
});

export {
  getEmployeeAssets,
  issueEmployeeAsset,
  updateEmployeeAsset,
  returnEmployeeAsset,
  markEmployeeAssetLost,
  deleteEmployeeAsset,
};
