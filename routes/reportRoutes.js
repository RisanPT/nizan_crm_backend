import express from 'express';
import {
  getFinanceReport,
  getFinancialAnalystReport,
} from '../controllers/reportController.js';
import {
  getMonthEndReview,
  getMonthlyTarget,
  saveMonthlyTarget,
} from '../controllers/monthEndController.js';
import {
  getDecisions,
  createDecision,
  updateDecision,
  deleteDecision,
} from '../controllers/ceoDecisionController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.get('/finance', protect, getFinanceReport);
router.get('/financial-analyst', protect, getFinancialAnalystReport);

// Month-End Review + Monthly Planning (CEO finance review).
router.get('/month-end', protect, getMonthEndReview);
router.get('/targets', protect, getMonthlyTarget);
router.put('/targets', protect, saveMonthlyTarget);

// CEO decisions / action items.
router.get('/decisions', protect, getDecisions);
router.post('/decisions', protect, createDecision);
router.put('/decisions/:id', protect, updateDecision);
router.delete('/decisions/:id', protect, deleteDecision);

export default router;
