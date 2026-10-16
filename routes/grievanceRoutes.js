import express from 'express';
import {
  getMine,
  getAll,
  raiseGrievance,
  updateGrievance,
  withdrawGrievance,
  deleteGrievance,
} from '../controllers/grievanceController.js';
import { protect, attachRolePermissions } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect, attachRolePermissions);

router.get('/mine', getMine);
router.route('/').get(getAll).post(raiseGrievance);
router.route('/:id').put(updateGrievance).delete(deleteGrievance);
router.post('/:id/withdraw', withdrawGrievance);

export default router;

