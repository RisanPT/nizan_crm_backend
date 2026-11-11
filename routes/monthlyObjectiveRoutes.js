import express from 'express';
import {
  getMonthlyObjectives,
  getMonthlyObjectiveTrend,
  createMonthlyObjective,
  updateMonthlyObjective,
  checkInKeyResult,
  closeMonthlyObjective,
  reopenMonthlyObjective,
  deleteMonthlyObjective,
  carryOverObjectives,
} from '../controllers/monthlyObjectiveController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);
router.route('/').get(getMonthlyObjectives).post(createMonthlyObjective);
router.get('/trend', getMonthlyObjectiveTrend); // before /:id
router.post('/carry-over', carryOverObjectives); // before /:id, which would read "carry-over" as an id
router.route('/:id').put(updateMonthlyObjective).delete(deleteMonthlyObjective);
router.patch('/:id/key-results/:krId', checkInKeyResult);
router.post('/:id/close', closeMonthlyObjective);
router.post('/:id/reopen', reopenMonthlyObjective);

export default router;
