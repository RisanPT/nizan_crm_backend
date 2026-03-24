import express from 'express';
import {
  deleteRegion,
  getRegionById,
  getRegions,
  saveRegion,
} from '../controllers/regionController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.get('/', getRegions);
router.get('/:id', getRegionById);

router.use(protect);
router.post('/', saveRegion);
router.put('/:id', saveRegion);
router.delete('/:id', deleteRegion);

export default router;
