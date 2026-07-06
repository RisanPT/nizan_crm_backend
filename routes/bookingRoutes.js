import express from 'express';
import {
  getBookings,
  getBookingById,
  getPaginatedBookings,
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
router.get('/paged', getPaginatedBookings);
router.route('/').get(getBookings).post(createBooking);
router.route('/:id').get(getBookingById).put(updateBooking).delete(deleteBooking);

export default router;
