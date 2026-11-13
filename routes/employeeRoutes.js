import express from 'express';
import {
  getEmployees,
  getEmployee,
  createEmployee,
  updateEmployee,
  deleteEmployee,
  getEmployeeIncrements,
  addEmployeeIncrement,
  getOrgTree,
  setReportingDetails,
  linkTimeboxAccount,
} from '../controllers/employeeController.js';
import Employee from '../models/Employee.js';
import { protect, attachRolePermissions } from '../middleware/authMiddleware.js';
import {
  canManageStaff,
  canSeeAllEmployeePay,
  hasModule,
  SENSITIVE_EMPLOYEE_FIELDS,
} from '../utils/hrAccess.js';
import { getHrScope, canManageEmployee } from '../utils/hrDeptScope.js';
import { isLeadership } from '../utils/leadership.js';

const router = express.Router();

router.use(protect, attachRolePermissions);

const forbid = (res, message) => res.status(403).json({ message });

/// Create / edit / delete:
///  • HR-wide (admin/manager, 'staff' module, HR department head): anyone.
///  • Other department heads: EDIT their own department's staff only;
///    creating and deleting employee records stays with HR.
///  • Fleet: DRIVER records only, never pay / bank / ID fields.
const employeeWriteGuard = async (req, res, next) => {
  try {
    const scope = await getHrScope(req, ['staff']);
    if (scope.wide) return next();

    if (canManageStaff(req.user) && req.params.id && req.method === 'PUT') {
      if (await canManageEmployee(req, req.params.id, ['staff'])) {
        // Pay changes go through Compensation (approved by someone else), and
        // a head can't move people out of their department from here.
        for (const f of [...SENSITIVE_EMPLOYEE_FIELDS, 'department', 'departmentId', 'status', 'employmentStatus']) {
          delete req.body[f];
        }
        return next();
      }
    }

    if (!hasModule(req.user, 'fleet')) {
      return forbid(res, req.params.id && canManageStaff(req.user)
        ? 'This employee is not in your department'
        : 'You are not allowed to manage employees');
    }
    if (req.params.id) {
      const existing = await Employee.findById(req.params.id).select('artistRole').lean();
      if (!existing) return res.status(404).json({ message: 'Employee not found' });
      if (existing.artistRole !== 'driver') return forbid(res, 'Fleet can only manage driver records');
    }
    if (req.method !== 'DELETE') {
      if (req.body?.artistRole !== undefined && req.body.artistRole !== 'driver') {
        return forbid(res, 'Fleet can only manage driver records');
      }
      if (!req.params.id) req.body.artistRole = 'driver';
      for (const f of SENSITIVE_EMPLOYEE_FIELDS) delete req.body[f];
    }
    return next();
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
};

/// HR-wide, or a department head acting on their own department's employee.
const inScope = async (req, res, next) => {
  try {
    if (!canManageStaff(req.user)) return forbid(res, 'You are not allowed to manage employees');
    if (await canManageEmployee(req, req.params.id, ['staff'])) return next();
    return forbid(res, 'This employee is not in your department');
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
};

/// Salary history / raises: company-wide pay viewers, or a dept head for
/// their own team.
const payInScope = async (req, res, next) => {
  try {
    // never the CEO / Executive Director: salary history is pay (they read totals on the dashboards)
    if (isLeadership(req.user)) return forbid(res, 'Salary details are not part of this login');
    if (canSeeAllEmployeePay(req.user)) return next();
    if (canManageStaff(req.user) && (await canManageEmployee(req, req.params.id, ['staff']))) return next();
    return forbid(res, 'You are not allowed to view salary details');
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
};

router.route('/').get(getEmployees).post(employeeWriteGuard, createEmployee);
// Declared before '/:id' so 'org-tree' isn't captured as an :id.
router.get('/org-tree', getOrgTree);
router
  .route('/:id')
  .get(getEmployee)
  .put(employeeWriteGuard, updateEmployee)
  .delete(employeeWriteGuard, deleteEmployee);
router.put('/:id/reporting', inScope, setReportingDetails);
router.put('/:id/timebox-link', inScope, linkTimeboxAccount);
router
  .route('/:id/increments')
  .get(payInScope, getEmployeeIncrements)
  .post(inScope, payInScope, addEmployeeIncrement);

export default router;
