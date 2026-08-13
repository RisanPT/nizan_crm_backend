import HraRecord from '../models/HraRecord.js';
import Employee from '../models/Employee.js';
import AdminExpense from '../models/AdminExpense.js';
import { postDoc, unpostDoc, safePost } from '../services/posting.js';

const populateEmp = { path: 'employeeId', select: 'name department email profileImage' };

// HRA payment mode → administrative-expense payment method.
const HRA_TO_ADMIN_METHOD = {
  bank_transfer: 'bank_transfer',
  upi: 'upi',
  cash: 'cash',
  cheque: 'other',
  other: 'other',
};

// The administrative-expense representation of an HRA record — HRA is a real
// company expense, so it must appear in Accounts expenses (and thus all expense
// stats / dashboards / reports). Kept in sync via sourceHraId.
function mirrorFieldsFor(record, userId) {
  return {
    title: `HRA — ${record.employeeName}`,
    department: record.department || 'General',
    category: 'staff_welfare',
    amount: Number(record.amount) || 0,
    date: record.date,
    paymentMethod: HRA_TO_ADMIN_METHOD[record.paymentMethod] || 'bank_transfer',
    status: record.status === 'paid' ? 'approved' : 'pending',
    notes: `House Rent Allowance${record.notes ? ` — ${record.notes}` : ''}`,
    source: 'hra',
    sourceHraId: record._id,
    createdBy: userId ?? null,
  };
}

// Create or update the mirrored administrative expense for an HRA record.
async function syncMirror(record, userId) {
  try {
    const fields = mirrorFieldsFor(record, userId);
    const existing = await AdminExpense.findOne({ sourceHraId: record._id });
    if (existing) {
      Object.assign(existing, fields);
      await existing.save();
    } else {
      await AdminExpense.create(fields);
    }
  } catch (err) {
    // Mirror is best-effort — never fail the HRA operation because of it.
    console.error('HRA → expense mirror failed:', err.message);
  }
}

// @desc  List HRA records (optional month/year/employee/status filters)
// @route GET /api/hra
export const getHraRecords = async (req, res) => {
  try {
    const { month, year, employeeId, status, search } = req.query;
    const filter = {};
    if (month && month !== 'all') filter.month = Number(month);
    if (year && year !== 'all') filter.year = Number(year);
    if (employeeId && employeeId !== 'all') filter.employeeId = employeeId;
    if (status && status !== 'all' && status !== 'All') filter.status = status;
    if (search) filter.employeeName = new RegExp(search, 'i');

    const records = await HraRecord.find(filter)
      .populate(populateEmp)
      .sort({ date: -1, createdAt: -1 });
    res.json(records);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// @desc  Totals for the HRA dashboard header.
// @route GET /api/hra/stats
export const getHraStats = async (req, res) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    const all = await HraRecord.find({}).lean();
    let totalAmount = 0;
    let thisMonthAmount = 0;
    let pendingAmount = 0;
    const employees = new Set();

    for (const r of all) {
      const amt = Number(r.amount) || 0;
      totalAmount += amt;
      if (r.status === 'pending') pendingAmount += amt;
      const d = new Date(r.date);
      if (d >= startOfMonth && d <= endOfMonth) thisMonthAmount += amt;
      if (r.employeeId) employees.add(String(r.employeeId));
    }

    res.json({
      totalCount: all.length,
      totalAmount,
      thisMonthAmount,
      pendingAmount,
      employeeCount: employees.size,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// @desc  Record an HRA payment for an employee.
// @route POST /api/hra
export const createHraRecord = async (req, res) => {
  try {
    const { employeeId, amount, date, paymentMethod, status, notes } = req.body;

    const employee = await Employee.findById(employeeId);
    if (!employee) return res.status(404).json({ message: 'Employee not found' });

    const d = date ? new Date(date) : new Date();
    const record = new HraRecord({
      employeeId: employee._id,
      employeeName: employee.name,
      department: employee.department || 'General',
      amount: Number(amount) || 0,
      date: d,
      month: d.getMonth() + 1,
      year: d.getFullYear(),
      paymentMethod: paymentMethod || 'bank_transfer',
      status: status || 'pending',
      notes: notes || '',
      createdBy: req.user?._id || null,
    });
    await record.save();
    await syncMirror(record, req.user?._id);
    // Post paid HRA to the ledger (best-effort).
    await safePost(() => postDoc('HraRecord', record.toObject(), req.user?._id || null));
    const populated = await HraRecord.findById(record._id).populate(populateEmp);
    res.status(201).json(populated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// @desc  Update an HRA record.
// @route PUT /api/hra/:id
export const updateHraRecord = async (req, res) => {
  try {
    const record = await HraRecord.findById(req.params.id);
    if (!record) return res.status(404).json({ message: 'HRA record not found' });

    const { amount, date, paymentMethod, status, notes } = req.body;
    if (amount !== undefined) record.amount = Number(amount) || 0;
    if (date !== undefined) {
      const d = new Date(date);
      record.date = d;
      record.month = d.getMonth() + 1;
      record.year = d.getFullYear();
    }
    if (paymentMethod !== undefined) record.paymentMethod = paymentMethod;
    if (status !== undefined) record.status = status;
    if (notes !== undefined) record.notes = notes;

    await record.save();
    await syncMirror(record, req.user?._id);
    // Post paid HRA to the ledger (best-effort).
    await safePost(() => postDoc('HraRecord', record.toObject(), req.user?._id || null));
    const populated = await HraRecord.findById(record._id).populate(populateEmp);
    res.json(populated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// @desc  Delete an HRA record.
// @route DELETE /api/hra/:id
export const deleteHraRecord = async (req, res) => {
  try {
    const record = await HraRecord.findById(req.params.id);
    if (!record) return res.status(404).json({ message: 'HRA record not found' });
    await record.deleteOne();
    await safePost(() => unpostDoc('HraRecord', record._id));
    // Remove the mirrored administrative expense too.
    try {
      await AdminExpense.deleteOne({ sourceHraId: record._id });
    } catch (err) {
      console.error('HRA mirror cleanup failed:', err.message);
    }
    res.json({ message: 'HRA record deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
