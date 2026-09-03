import express from 'express';
import {
  getExpenseCategories,
  createExpenseCategory,
  updateExpenseCategory,
  deleteExpenseCategory,
} from '../controllers/expenseCategoryController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);

router.route('/').get(getExpenseCategories).post(createExpenseCategory);
router.route('/:id').put(updateExpenseCategory).delete(deleteExpenseCategory);

export default router;
