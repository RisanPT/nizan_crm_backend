import express from 'express';
import {
  getFuelExpenses,
  createFuelExpense,
  updateFuelExpense,
  deleteFuelExpense,
} from '../controllers/fuelExpenseController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);
router.route('/').get(getFuelExpenses).post(createFuelExpense);
router.route('/:id').put(updateFuelExpense).delete(deleteFuelExpense);

export default router;
