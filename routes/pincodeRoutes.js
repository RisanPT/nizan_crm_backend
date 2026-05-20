import express from 'express';
import {
  deletePincode,
  getPincodeById,
  getPincodes,
  savePincode,
} from '../controllers/pincodeController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.get('/', getPincodes);
router.get('/:id', getPincodeById);

router.use(protect);
router.post('/', savePincode);
router.put('/:id', savePincode);
router.delete('/:id', deletePincode);

export default router;
