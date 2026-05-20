import express from 'express';
import {
  deleteDistrict,
  getDistrictById,
  getDistricts,
  saveDistrict,
} from '../controllers/districtController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.get('/', getDistricts);
router.get('/:id', getDistrictById);

router.use(protect);
router.post('/', saveDistrict);
router.put('/:id', saveDistrict);
router.delete('/:id', deleteDistrict);

export default router;
