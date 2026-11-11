import express from 'express';
import { listFuelPrices, createFuelPrice, updateFuelPrice, deleteFuelPrice } from '../controllers/fuelPriceController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);

router.route('/').get(listFuelPrices).post(createFuelPrice);
router.route('/:id').put(updateFuelPrice).delete(deleteFuelPrice);

export default router;
