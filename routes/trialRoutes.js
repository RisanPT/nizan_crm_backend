import express from 'express';
import {
  getTrials,
  getTrialById,
  createTrial,
  updateTrial,
  deleteTrial,
} from '../controllers/trialController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);
router.route('/').get(getTrials).post(createTrial);
router.route('/:id').get(getTrialById).put(updateTrial).delete(deleteTrial);

export default router;
