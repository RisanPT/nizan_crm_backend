import express from 'express';
import {
  getEvaluations,
  getEmployeeEvaluations,
  upsertEvaluation,
  deleteEvaluation,
} from '../controllers/performanceController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);

router.route('/').get(getEvaluations).post(upsertEvaluation);
router.get('/employee/:employeeId', getEmployeeEvaluations);
router.delete('/:id', deleteEvaluation);

export default router;
