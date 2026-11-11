import express from 'express';
import { getWorkProfit } from '../controllers/workProfitController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);
router.get('/', getWorkProfit);

export default router;
