import express from 'express';
import {
  deleteZone,
  getZoneById,
  getZones,
  saveZone,
} from '../controllers/zoneController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.get('/', getZones);
router.get('/:id', getZoneById);

router.use(protect);
router.post('/', saveZone);
router.put('/:id', saveZone);
router.delete('/:id', deleteZone);

export default router;
