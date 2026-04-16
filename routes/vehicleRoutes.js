import express from 'express';
import {
  getVehicles,
  createVehicle,
  updateVehicle,
  deleteVehicle,
} from '../controllers/vehicleController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);
router.route('/').get(getVehicles).post(createVehicle);
router.route('/:id').put(updateVehicle).delete(deleteVehicle);

export default router;
