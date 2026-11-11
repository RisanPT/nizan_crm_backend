import express from 'express';
import {
  getSalesDashboard,
  getMarketingDashboard,
  getFinanceDashboard,
} from '../controllers/dashboardController.js';
import { getSalesOverview } from '../controllers/salesOverviewController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);

router.get('/sales', getSalesDashboard);
// Sales Dashboard screen (redesigned) — every figure computed server-side.
router.get('/sales-overview', getSalesOverview);
router.get('/marketing', getMarketingDashboard);
router.get('/finance', getFinanceDashboard);

export default router;
