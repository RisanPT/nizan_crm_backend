import express from 'express';
import asyncHandler from 'express-async-handler';
import { protect } from '../middleware/authMiddleware.js';
import { attachMarketingAccess } from '../controllers/marketingEodController.js';
import { canManageMarketing } from '../controllers/contentController.js';
import { getWeeklyReport } from '../controllers/marketingWeeklyController.js';

// /api/marketing/weekly — the Marketing Weekly Report.
// Marketing roles only (the same gate as /api/content); the CEO / Executive Director read it through the leadership guard.
// Add this module's endpoints below the gate (see routes/marketingSocialsRoutes.js and routes/marketingPortfolioRoutes.js for the pattern).
const router = express.Router();
router.use(protect);
router.use(attachMarketingAccess);
router.use(
  asyncHandler(async (req, res, next) => {
    if (await canManageMarketing(req.user)) return next();
    res.status(403);
    throw new Error('Only the Marketing team can open this.');
  }),
);

router.get('/', asyncHandler(getWeeklyReport));

export default router;
