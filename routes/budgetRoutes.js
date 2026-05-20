import express from 'express';
import { getBudgets, setBudget } from '../controllers/budgetController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.route('/').get(protect, getBudgets).post(protect, setBudget);

export default router;
