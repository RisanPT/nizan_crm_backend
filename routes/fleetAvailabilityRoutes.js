import express from 'express';
import { checkAssignment, getBookingAvailability, getDayAvailability } from '../controllers/fleetAvailabilityController.js';
import { fleetRolesOnly } from '../controllers/vehicleEfficiencyController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect, fleetRolesOnly);

router.get('/booking/:id', getBookingAvailability);
router.get('/day', getDayAvailability);
router.post('/check', checkAssignment);

export default router;
