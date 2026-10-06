import express from 'express';
import {
  copyLastMonth,
  getMyTarget,
  getTeamTargets,
  saveTargets,
} from '../controllers/salesTargetController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);

router.get('/me', getMyTarget);
router.get('/', getTeamTargets);
router.put('/', saveTargets);
router.post('/copy', copyLastMonth);

export default router;
