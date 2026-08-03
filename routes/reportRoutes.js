import express from 'express';
import {
  getFinanceReport,
  getFinancialAnalystReport,
} from '../controllers/reportController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.get('/finance', protect, getFinanceReport);
router.get('/financial-analyst', protect, getFinancialAnalystReport);

export default router;
