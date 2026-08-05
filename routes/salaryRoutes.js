import express from 'express';
import {
  getSalaries,
  generateMonthlySalaries,
  createSalary,
  updateSalary,
  approveSalary,
  paySalary,
  deleteSalary,
  submitPayrollToAccounts,
} from '../controllers/salaryController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);

router.route('/').get(getSalaries).post(createSalary);
router.route('/generate').post(generateMonthlySalaries);
router.route('/submit').post(submitPayrollToAccounts);
router.route('/:id').put(updateSalary).delete(deleteSalary);
router.route('/:id/approve').put(approveSalary);
router.route('/:id/pay').put(paySalary);

export default router;
