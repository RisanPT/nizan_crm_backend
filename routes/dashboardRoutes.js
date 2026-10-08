import express from 'express';
import {
  getSalesDashboard,
  getMarketingDashboard,
  getFinanceDashboard,
} from '../controllers/dashboardController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);

router.get('/sales', getSalesDashboard);
router.get('/marketing', getMarketingDashboard);
router.get('/finance', getFinanceDashboard);

export default router;
