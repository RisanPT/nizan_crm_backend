import express from 'express';
import {
  getBlockedDates,
  createBlockedDate,
  updateBlockedDate,
  deleteBlockedDate,
} from '../controllers/blockedDateController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.get('/', getBlockedDates);

router.use(protect);
router.post('/', createBlockedDate);
router.put('/:id', updateBlockedDate);
router.delete('/:id', deleteBlockedDate);

export default router;
