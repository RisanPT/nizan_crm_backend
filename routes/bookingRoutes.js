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
import { getNextWorkHints } from '../controllers/artistDayController.js';
import { fleetAssignmentGuard } from '../middleware/fleetAssignmentGuard.js';
import { artistAssignmentGuard } from '../middleware/artistAssignmentGuard.js';

const router = express.Router();

router.get('/public', getPublicBookings);
router.post('/public', createBooking);

router.use(protect);
router.get('/paged', getPaginatedBookings);
// Users whose entered bookings are left out of sales totals (before '/:id').
router.get('/sales-excluded-creators', getSalesExcludedCreatorsHandler);
// Booking Map: bookings grouped by place with coordinates (before '/:id').
router.get('/map', getBookingMap);
// An artist's works screen: where each work falls in their day + the road to the next one (before '/:id').
router.get('/next-work', getNextWorkHints);
// A driver / vehicle that is already on another work then (or unavailable) needs a confirmation.
// An artist put on a NEW booking who is already on another work then, on leave, or out of slots needs one too (artistAssignmentGuard).
router.route('/').get(getBookings).post(fleetAssignmentGuard, artistAssignmentGuard, createBooking);
router.route('/:id').get(getBookingById).put(fleetAssignmentGuard, artistAssignmentGuard, updateBooking).delete(deleteBooking);

export default router;
