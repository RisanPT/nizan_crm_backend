import express from 'express';
import {
  getExpenses,
  createExpense,
  verifyExpense,
  deleteExpense,
  updateExpense,
} from '../controllers/expenseController.js';
import { getMealPreview, getArtistDay, getWorkCosts } from '../controllers/workCostController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);

router.route('/').get(getExpenses).post(createExpense);
// Food by the time of the meal, put under the work it was eaten for (before '/:id').
router.get('/meal-preview', getMealPreview); //  the artist's preview while adding a meal
router.get('/artist-day', getArtistDay); //      one artist's day as a timeline
router.get('/work-costs', getWorkCosts); //      Accounts: what each work cost
router.route('/:id').put(updateExpense).delete(deleteExpense);
router.route('/:id/verify').put(verifyExpense);

export default router;
