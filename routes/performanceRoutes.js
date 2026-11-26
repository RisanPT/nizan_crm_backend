import express from 'express';
import {
  getEvaluations,
  getEmployeeEvaluations,
  upsertEvaluation,
  deleteEvaluation,
} from '../controllers/performanceController.js';
import { protect, attachRolePermissions } from '../middleware/authMiddleware.js';

const router = express.Router();

// Role permissions feed the HR scope (HR dept head / module keys = company-wide).
router.use(protect, attachRolePermissions);

router.route('/').get(getEvaluations).post(upsertEvaluation);
router.get('/employee/:employeeId', getEmployeeEvaluations);
router.delete('/:id', deleteEvaluation);

export default router;
