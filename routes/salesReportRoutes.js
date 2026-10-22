import express from 'express';
import {
  salesByCustomer,
  salesByPackage,
  salesBySalesperson,
  salesSummary,
  paymentsByMode,
  salesEodReport,
} from '../controllers/salesReportController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);

router.get('/eod', salesEodReport);
router.get('/by-customer', salesByCustomer);
router.get('/by-package', salesByPackage);
router.get('/by-salesperson', salesBySalesperson);
router.get('/summary', salesSummary);
router.get('/by-payment-mode', paymentsByMode);

export default router;
