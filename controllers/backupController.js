import asyncHandler from 'express-async-handler';
import mongoose from 'mongoose';
import { permissionsForRole } from './roleController.js';

// Which Mongoose models hold each department's data. Names are matched against
// the actually-registered models at request time, so an unregistered name is
// simply skipped (never throws).
const DEPARTMENT_COLLECTIONS = {
  sales: ['Lead', 'LeadActivity', 'Booking', 'Trial', 'Customer', 'MonthlyTarget'],
  crm: ['Customer', 'Lead', 'LeadActivity'],
  accounts: ['Collection', 'Expense', 'AdminExpense', 'Subscription', 'Salary',
    'SalaryIncrement', 'SalesReturn', 'BankAccount', 'BankStatementLine',
    'ChartOfAccount', 'JournalEntry', 'AccountingSetting', 'GstSetting',
    'AccountReport', 'DepreciationRun', 'Budget'],
  finance: ['Asset', 'BankAccount', 'Budget', 'JournalEntry', 'ChartOfAccount',
    'MonthlyTarget', 'CeoDecision', 'DepartmentReport'],
  hr: ['Employee', 'Attendance', 'HraRecord', 'Salary', 'SalaryIncrement',
    'StaffKit', 'SlotCapacity'],
  marketing: ['Competitor', 'CompetitorSnapshot', 'ScoringConfig', 'ContentItem'],
  it: ['Project', 'ITTask', 'Ticket'],
  fleet: ['Vehicle', 'FuelExpense', 'AccidentReport', 'ServiceReminder',
    'DriverReview', 'BlockedDate'],
  artist: ['Booking', 'Trial', 'StaffKit', 'Collection'],
};

const DEPARTMENT_LABEL = {
  sales: 'Sales', crm: 'CRM', accounts: 'Accounts', finance: 'Finance',
  hr: 'HR', marketing: 'Marketing', it: 'IT', fleet: 'Fleet', artist: 'Artist',
};

// The permission key a NON-admin must hold to back up a given department.
const DEPARTMENT_PERMISSION = {
  sales: 'sales', crm: 'clients', accounts: 'payables', finance: 'company_finance',
  hr: 'staff', marketing: 'marketing', it: 'it', fleet: 'fleet', artist: 'bookings',
};

// IT / admin / manager (or any role granted the `it` permission) may back up
// ANY department and take a full-database backup.
const BACKUP_ADMIN_ROLES = new Set(['admin', 'manager', 'it']);
const isBackupAdmin = async (user) => {
  if (!user) return false;
  if (BACKUP_ADMIN_ROLES.has(user.role)) return true;
  try {
    return (await permissionsForRole(user.role)).includes('it');
  } catch {
    return false;
  }
};

const canBackupDepartment = async (user, dept) => {
  if (!DEPARTMENT_COLLECTIONS[dept]) return false;
  if (await isBackupAdmin(user)) return true;
  const perm = DEPARTMENT_PERMISSION[dept];
  try {
    return !!perm && (await permissionsForRole(user.role)).includes(perm);
  } catch {
    return false;
  }
};

// Dump one registered model's whole collection (User has its password stripped).
const dumpModel = async (name) => {
  if (!mongoose.modelNames().includes(name)) return null;
  const Model = mongoose.model(name);
  const q = Model.find({}).lean();
  if (name === 'User') q.select('-password');
  return q;
};

const stamp = () => new Date().toISOString().slice(0, 10);
const send = (res, filename, payload) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(JSON.stringify(payload, null, 2));
};

// @route GET /api/backup/departments — which departments the caller may back up.
export const getBackupTargets = asyncHandler(async (req, res) => {
  const admin = await isBackupAdmin(req.user);
  const targets = [];
  for (const key of Object.keys(DEPARTMENT_COLLECTIONS)) {
    if (await canBackupDepartment(req.user, key)) {
      targets.push({ key, label: DEPARTMENT_LABEL[key], collections: DEPARTMENT_COLLECTIONS[key].length });
    }
  }
  res.json({ full: admin, departments: targets });
});

// @route GET /api/backup/department/:department — one department's data as a JSON file.
export const backupDepartment = asyncHandler(async (req, res) => {
  const dept = String(req.params.department || '').toLowerCase().trim();
  if (!DEPARTMENT_COLLECTIONS[dept]) { res.status(404); throw new Error('Unknown department'); }
  if (!(await canBackupDepartment(req.user, dept))) {
    res.status(403); throw new Error('You are not allowed to back up this department');
  }

  const data = {};
  const counts = {};
  const skipped = [];
  for (const name of DEPARTMENT_COLLECTIONS[dept]) {
    const docs = await dumpModel(name);
    if (docs === null) { skipped.push(name); continue; }
    data[name] = docs;
    counts[name] = docs.length;
  }

  send(res, `${dept}-backup-${stamp()}.json`, {
    meta: {
      type: 'department-backup',
      department: dept,
      label: DEPARTMENT_LABEL[dept],
      exportedAt: new Date().toISOString(),
      exportedBy: req.user?.name || '',
      exportedById: req.user?._id || null,
      counts,
      skipped,
    },
    data,
  });
});

// @route GET /api/backup/full — every collection (IT / admin only).
export const backupFull = asyncHandler(async (req, res) => {
  if (!(await isBackupAdmin(req.user))) {
    res.status(403); throw new Error('Only IT / admin can take a full backup');
  }
  const data = {};
  const counts = {};
  for (const name of mongoose.modelNames().sort()) {
    const docs = await dumpModel(name);
    if (docs === null) continue;
    data[name] = docs;
    counts[name] = docs.length;
  }
  send(res, `full-backup-${stamp()}.json`, {
    meta: {
      type: 'full-backup',
      exportedAt: new Date().toISOString(),
      exportedBy: req.user?.name || '',
      exportedById: req.user?._id || null,
      collectionCount: Object.keys(data).length,
      counts,
    },
    data,
  });
});
