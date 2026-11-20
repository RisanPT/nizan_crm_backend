import express from 'express';
import asyncHandler from 'express-async-handler';
import { protect } from '../middleware/authMiddleware.js';
import { attachMarketingAccess } from '../controllers/marketingEodController.js';
import { canManageMarketing } from '../controllers/contentController.js';
import { createSaved, deleteSaved, listSaved, listSchedules, updateSchedule } from '../controllers/marketingReportsController.js';

// /api/marketing/reports — Saved and Scheduled reports of the Team Dashboard, Campaigns and Lead Report.
// Marketing roles only (the same gate as the other marketing modules); the CEO / Executive Director read through the leadership guard.
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

router.get('/schedules', asyncHandler(listSchedules));
router.put('/schedules/:key', asyncHandler(updateSchedule));
router.get('/saved', asyncHandler(listSaved));
router.post('/saved', asyncHandler(createSaved));
router.delete('/saved/:id', asyncHandler(deleteSaved));

export default router;
