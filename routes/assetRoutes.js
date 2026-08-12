import express from 'express';
import {
  getAssets,
  getAssetStats,
  createAsset,
  updateAsset,
  deleteAsset,
} from '../controllers/assetController.js';
import {
  getSchedule,
  runDepreciation,
  getRuns,
} from '../controllers/depreciationController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);

router.route('/').get(getAssets).post(createAsset);
router.get('/stats', getAssetStats);

// Depreciation (before /:id so these named paths aren't swallowed by it).
router.get('/depreciation/schedule', getSchedule);
router.post('/depreciation/run', runDepreciation);
router.get('/depreciation/runs', getRuns);

router.route('/:id').put(updateAsset).delete(deleteAsset);

export default router;
