import express from 'express';
import {
  getExpenses,
  createExpense,
  verifyExpense,
  deleteExpense,
} from '../controllers/expenseController.js';

const router = express.Router();

router.route('/').get(getExpenses).post(createExpense);
router.route('/:id').delete(deleteExpense);
router.route('/:id/verify').put(verifyExpense);

export default router;
