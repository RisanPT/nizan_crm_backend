import express from 'express';
import {
  getOKRs,
  getOKRById,
  createOKR,
  updateOKR,
  deleteOKR,
} from '../controllers/okrController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);

router.route('/')
  .get(getOKRs)
  .post(createOKR);

router.route('/:id')
  .get(getOKRById)
  .put(updateOKR)
  .delete(deleteOKR);

export default router;
