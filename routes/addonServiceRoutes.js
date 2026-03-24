import express from 'express';
import {
  getAddonServices,
  saveAddonService,
  deleteAddonService,
} from '../controllers/addonServiceController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);
router.route('/').get(getAddonServices).post(saveAddonService);
router.route('/:id').put(saveAddonService).delete(deleteAddonService);

export default router;
