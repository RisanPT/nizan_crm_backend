import express from 'express';
import { protectClient, optionalProtectClient } from '../middleware/clientAuthMiddleware.js';
import {
  getMe,
  updateMe,
  deleteMe,
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
import {
  getAvailability,
  holdSlot,
  releaseSlotHold,
  getDistrictsAndTravel,
  calculateEstimate,
} from '../controllers/clientBookingEngineController.js';
import { createBooking } from '../controllers/bookingController.js';
import tryOnRoutes from './tryOnRoutes.js';

const router = express.Router();

// ─── Module B: Public/Optional-Auth Discovery & Calculation Endpoints ────────
router.get('/availability', optionalProtectClient, getAvailability);
router.get('/districts', optionalProtectClient, getDistrictsAndTravel);
router.post('/estimate', optionalProtectClient, calculateEstimate);

// ─── Protected Client Endpoints ──────────────────────────────────────────────
router.use(protectClient);

router.get('/me', getMe);
router.put('/me', updateMe);
router.delete('/me', deleteMe);
router.get('/preferences', getPreferences);
router.put('/preferences', savePreferences);
router.get('/lookboard', getLookBoard);
router.put('/lookboard', saveLookBoard);
router.get('/lookplan', getLookPlan);
router.put('/lookplan', saveLookPlan);
router.get('/bookings', getMyBookings);
router.get('/bookings/:id', getMyBooking);

// ─── Module B: Slot Hold & Release (Atomic Concurrency Control) ──────────────
router.post('/bookings/hold', holdSlot);
router.delete('/bookings/hold/:id', releaseSlotHold);


// Reuses the shared public createBooking (public branch: status 'pending',
// upserts a Customer). forceClientIdentity pins the booking to this client.
router.post('/bookings', forceClientIdentity, createBooking);
// "Preview on me" (face try-on). Consent-gated; see controllers/tryOnController.js.
router.use('/tryon', tryOnRoutes);

export default router;

