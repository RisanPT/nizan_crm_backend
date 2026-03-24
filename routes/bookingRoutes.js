import express from 'express';
import {
  getBookings,
  getPublicBookings,
  createBooking,
  updateBooking,
  deleteBooking,
} from '../controllers/bookingController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.get('/public', getPublicBookings);
router.post('/public', createBooking);

router.use(protect);
router.route('/').get(getBookings).post(createBooking);
router.route('/:id').put(updateBooking).delete(deleteBooking);

export default router;
