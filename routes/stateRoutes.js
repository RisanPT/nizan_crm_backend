import express from 'express';
import {
  deleteState,
  getStateById,
  getStates,
  saveState,
} from '../controllers/stateController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.get('/', getStates);
router.get('/:id', getStateById);

router.use(protect);
router.post('/', saveState);
router.put('/:id', saveState);
router.delete('/:id', deleteState);

export default router;
