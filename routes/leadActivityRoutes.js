import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import {
  getLeadActivities,
  createLeadActivity,
  updateLeadActivity,
  deleteLeadActivity,
} from '../controllers/leadActivityController.js';

// mergeParams: true allows accessing leadId from the parent router
const router = express.Router({ mergeParams: true });

router.use(protect);

router.route('/')
  .get(getLeadActivities)
  .post(createLeadActivity);

router.route('/:id')
  .put(updateLeadActivity)
  .delete(deleteLeadActivity);

export default router;
