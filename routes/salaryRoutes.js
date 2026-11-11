import express from 'express';
import {
  getSalaries,
  getMySalaries,
  generateMonthlySalaries,
  createSalary,
  updateSalary,
  approveSalary,
  paySalary,
  deleteSalary,
  submitPayrollToAccounts,
  getPayrollLocks,
  lockPayrollMonth,
  unlockPayrollMonth,
} from '../controllers/salaryController.js';
import { protect, attachRolePermissions } from '../middleware/authMiddleware.js';
import { canManagePayroll, requireAccess } from '../utils/hrAccess.js';

const router = express.Router();

// ESS: a user's OWN payslips (approved / paid). Declared before the payroll
// gate so any logged-in employee can read their slips — never anyone else's.
router.get('/mine', protect, getMySalaries);

// Salary slips hold pay + bank details: HR salaries / Accounts payroll only.
router.use(protect, attachRolePermissions, requireAccess(canManagePayroll, 'You are not allowed to access salaries'));

router.route('/').get(getSalaries).post(createSalary);
router.route('/generate').post(generateMonthlySalaries);
router.route('/submit').post(submitPayrollToAccounts);
router.get('/locks', getPayrollLocks);
router.post('/lock', lockPayrollMonth);
router.post('/unlock', unlockPayrollMonth);
router.route('/:id').put(updateSalary).delete(deleteSalary);
router.route('/:id/approve').put(approveSalary);
router.route('/:id/pay').put(paySalary);

export default router;
