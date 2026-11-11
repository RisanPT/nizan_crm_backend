import express from 'express';
import { getGpsKmComparison, uploadGpsKm } from '../controllers/gpsKmController.js';
import { fleetRolesOnly } from '../controllers/vehicleEfficiencyController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

// fleet_manager / admin / manager — the same people who see the day sheet.
router.post('/upload', protect, fleetRolesOnly, uploadGpsKm);
router.get('/compare', protect, fleetRolesOnly, getGpsKmComparison);

export default router;
