import express from 'express';
import {
  getOKRs,
  getOKRById,
  createOKR,
  updateOKR,
  updateKeyResult,
  deleteOKR,
} from '../controllers/okrController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);

router.route('/')
  .get(getOKRs)
  .post(createOKR);

// One key result at a time (a check-in), so people don't overwrite each other.
router.patch('/:id/key-results/:krId', updateKeyResult);

router.route('/:id')
  .get(getOKRById)
  .put(updateOKR)
  .delete(deleteOKR);

export default router;
