import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import { attachMarketingAccess } from '../controllers/marketingEodController.js';
import { getOverview } from '../controllers/creativeController.js';

// /api/creative — the Creative Director dashboard (read-only; the work itself is changed on the Marketing screens it links to).
const router = express.Router();
router.use(protect);
router.use(attachMarketingAccess);
router.get('/overview', getOverview);

export default router;
