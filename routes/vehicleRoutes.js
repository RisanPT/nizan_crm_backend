import express from 'express';
import {
  getVehicles,
  createVehicle,
  updateVehicle,
  deleteVehicle,
} from '../controllers/vehicleController.js';
import {
  getVehicleCategories,
  getVehicleEfficiency,
  getFleetEfficiency,
  fleetRolesOnly,
} from '../controllers/vehicleEfficiencyController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);
router.route('/').get(getVehicles).post(createVehicle);
// Before '/:id' so "categories" / "efficiency" aren't read as an id.
router.get('/categories', getVehicleCategories);
router.get('/efficiency', fleetRolesOnly, getFleetEfficiency);
router.get('/:id/efficiency', fleetRolesOnly, getVehicleEfficiency);
router.route('/:id').put(updateVehicle).delete(deleteVehicle);

export default router;
