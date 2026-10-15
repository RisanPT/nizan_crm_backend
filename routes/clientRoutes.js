import express from 'express';
import { protectClient } from '../middleware/clientAuthMiddleware.js';
import {
  getMe,
  updateMe,
  getMyBookings,
  getMyBooking,
  forceClientIdentity,
  getPreferences,
  savePreferences,
  getLookBoard,
  saveLookBoard,
  getLookPlan,
  saveLookPlan,
} from '../controllers/clientController.js';
import { createBooking } from '../controllers/bookingController.js';
import tryOnRoutes from './tryOnRoutes.js';

const router = express.Router();

router.use(protectClient);

router.get('/me', getMe);
router.put('/me', updateMe);
router.get('/preferences', getPreferences);
router.put('/preferences', savePreferences);
router.get('/lookboard', getLookBoard);
router.put('/lookboard', saveLookBoard);
router.get('/lookplan', getLookPlan);
router.put('/lookplan', saveLookPlan);
router.get('/bookings', getMyBookings);
router.get('/bookings/:id', getMyBooking);
// Reuses the shared public createBooking (public branch: status 'pending',
// upserts a Customer). forceClientIdentity pins the booking to this client.
router.post('/bookings', forceClientIdentity, createBooking);
// "Preview on me" (face try-on). Consent-gated; see controllers/tryOnController.js.
router.use('/tryon', tryOnRoutes);

export default router;
