import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import {
  getStrategicVision,
  updateStrategicVision,
  addOrUpdateMilestone,
  deleteMilestone,
  getStrategicAlignment,
} from '../controllers/strategicVisionController.js';

const router = express.Router();

router.use(protect);

router.route('/')
  .get(getStrategicVision)
  .put(updateStrategicVision);

router.route('/alignment')
  .get(getStrategicAlignment);

router.route('/milestones')
  .post(addOrUpdateMilestone);

router.route('/milestones/:id')
  .delete(deleteMilestone);

export default router;

