import express from 'express';
import {
  getOnboardings,
  createOnboarding,
  updateOnboarding,
  deleteOnboarding,
} from '../controllers/onboardingController.js';
import { protect, attachRolePermissions } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect, attachRolePermissions);

router.route('/').get(getOnboardings).post(createOnboarding);
router.route('/:id').put(updateOnboarding).delete(deleteOnboarding);

export default router;
