import express from 'express';
import {
  getExpenses,
  createExpense,
  verifyExpense,
  deleteExpense,
  updateExpense,
} from '../controllers/expenseController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);

router.route('/').get(getExpenses).post(createExpense);
router.route('/:id').put(updateExpense).delete(deleteExpense);
router.route('/:id/verify').put(verifyExpense);

export default router;
