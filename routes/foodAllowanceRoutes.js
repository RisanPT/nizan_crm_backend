import express from 'express';
import { listAllowances, createAllowance, updateAllowance, deleteAllowance } from '../controllers/foodAllowanceController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);

router.route('/').get(listAllowances).post(createAllowance);
router.route('/:id').put(updateAllowance).delete(deleteAllowance);

export default router;
