import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import {
  getDefaults,
  updateDefaults,
  upsertDay,
  clearDay,
  getMonth,
} from '../controllers/slotController.js';

const router = express.Router();

router.use(protect);

// Read (any authenticated user — salespeople see availability).
router.get('/defaults', getDefaults);
router.get('/month', getMonth);

// Manage (HR / full-access only — enforced in the controller).
router.put('/defaults', updateDefaults);
router.put('/day', upsertDay);
router.delete('/day', clearDay);

export default router;
