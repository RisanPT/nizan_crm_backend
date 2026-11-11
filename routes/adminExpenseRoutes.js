import express from 'express';
import {
  getAdminExpenses,
  getAdminExpenseStats,
  getExpenseHeads,
  createExpenseHead,
  updateExpenseHead,
  deleteExpenseHead,
  getAdminExpenseById,
  createAdminExpense,
  updateAdminExpense,
  verifyAdminExpense,
  deleteAdminExpense,
} from '../controllers/adminExpenseController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);

router.route('/stats').get(getAdminExpenseStats);
router.route('/heads').get(getExpenseHeads).post(createExpenseHead);
router.route('/heads/:id').put(updateExpenseHead).delete(deleteExpenseHead);
router.route('/').get(getAdminExpenses).post(createAdminExpense);
router.route('/:id').get(getAdminExpenseById).put(updateAdminExpense).delete(deleteAdminExpense);
router.route('/:id/verify').put(verifyAdminExpense);

export default router;
