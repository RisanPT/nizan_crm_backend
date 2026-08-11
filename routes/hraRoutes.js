import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import {
  getHraRecords,
  getHraStats,
  createHraRecord,
  updateHraRecord,
  deleteHraRecord,
} from '../controllers/hraController.js';

const router = express.Router();

router.use(protect);

router.get('/', getHraRecords);
router.get('/stats', getHraStats);
router.post('/', createHraRecord);
router.put('/:id', updateHraRecord);
router.delete('/:id', deleteHraRecord);

export default router;
