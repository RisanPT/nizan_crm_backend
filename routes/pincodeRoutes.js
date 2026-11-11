import express from 'express';
import {
  deletePincode,
  getPincodeById,
  getPincodes,
  lookupPincode,
  savePincode,
} from '../controllers/pincodeController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.get('/', getPincodes);
// One pincode → its place, for the pincode field on forms (before '/:id').
router.get('/lookup/:code', protect, lookupPincode);
router.get('/:id', getPincodeById);

router.use(protect);
router.post('/', savePincode);
router.put('/:id', savePincode);
router.delete('/:id', deletePincode);

export default router;
