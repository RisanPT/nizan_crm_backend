import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import {
  getBookingAdvances,
  verifyBookingAdvance,
  getAdvanceSettings,
  updateAdvanceSettings,
} from '../controllers/bookingAdvanceController.js';

const router = express.Router();

router.use(protect);

router.get('/', getBookingAdvances);
router.route('/settings').get(getAdvanceSettings).put(updateAdvanceSettings);
router.put('/:id/verify', verifyBookingAdvance);

export default router;
