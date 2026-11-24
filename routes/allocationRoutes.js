import express from 'express';
import asyncHandler from 'express-async-handler';
import { protect } from '../middleware/authMiddleware.js';
import { mayViewAllocation } from '../utils/allocationAccess.js';
import { approveExtra, confirm, confirmSeveral, getBookingStatus, getBookingSuggestions, getDay, previewBooking, getMetrics, getSettings, planMany, putSettings, rejectExtra, release } from '../controllers/allocationController.js';

// /api/allocation — the smart booking allocation (controllers/allocationController.js). Who may do what inside: utils/allocationAccess.js.
const router = express.Router();
router.use(protect);
// one booking's artist (or why it waits) — the salespeople read this too, so it sits before the allocation readers' gate
router.get('/booking/:id/status', getBookingStatus);
router.post('/preview', previewBooking);
router.use(
  asyncHandler(async (req, res, next) => {
    if (mayViewAllocation(req.user)) return next();
    res.status(403);
    throw new Error('The allocation is for the CRM team, the Artist Head and managers.');
  }),
);
router.route('/settings').get(getSettings).put(putSettings);
router.get('/booking/:id', getBookingSuggestions);
router.post('/plan', planMany);
router.post('/confirm', confirm);
router.post('/confirm-many', confirmSeveral);
router.post('/release', release);
router.get('/day', getDay);
router.get('/metrics', getMetrics);
router.post('/:id/approve', approveExtra);
router.post('/:id/reject', rejectExtra);
export default router;
