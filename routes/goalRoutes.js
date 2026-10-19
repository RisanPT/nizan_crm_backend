import express from 'express';
import { getGoalReport, getGoals, getMtd, saveGoals } from '../controllers/goalController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);

router.get('/report', getGoalReport);
router.get('/mtd', getMtd);
router.get('/', getGoals);
router.put('/', saveGoals);

export default router;
