import express from 'express';
import {
  copyLastMonth,
  createCombinedTarget,
  deleteCombinedTarget,
  getCombinedTargets,
  getMyTarget,
  getTeamTargets,
  saveTargets,
  updateCombinedTarget,
} from '../controllers/salesTargetController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);

router.get('/me', getMyTarget);
router.get('/', getTeamTargets);
router.put('/', saveTargets);
router.post('/copy', copyLastMonth);
router.get('/combined', getCombinedTargets);
router.post('/combined', createCombinedTarget);
router.put('/combined/:id', updateCombinedTarget);
router.delete('/combined/:id', deleteCombinedTarget);

export default router;
