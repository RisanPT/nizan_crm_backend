import express from 'express';
import {
  getOffboardings,
  createOffboarding,
  updateOffboarding,
  deleteOffboarding,
} from '../controllers/offboardingController.js';
import { protect, attachRolePermissions } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect, attachRolePermissions);

router.route('/').get(getOffboardings).post(createOffboarding);
router.route('/:id').put(updateOffboarding).delete(deleteOffboarding);

export default router;
