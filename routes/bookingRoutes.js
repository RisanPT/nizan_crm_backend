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
import { getSalesExcludedCreatorsHandler } from '../utils/salesRules.js';
import { getBookingMap } from '../controllers/bookingMapController.js';

const router = express.Router();

router.get('/public', getPublicBookings);
router.post('/public', createBooking);

router.use(protect);
router.get('/paged', getPaginatedBookings);
// Users whose entered bookings are left out of sales totals (before '/:id').
router.get('/sales-excluded-creators', getSalesExcludedCreatorsHandler);
// Booking Map: bookings grouped by place with coordinates (before '/:id').
router.get('/map', getBookingMap);
router.route('/').get(getBookings).post(createBooking);
router.route('/:id').get(getBookingById).put(updateBooking).delete(deleteBooking);

export default router;
