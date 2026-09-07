import express from 'express';
import {
  getPayouts,
  createPayout,
  updatePayout,
  approvePayout,
  payPayout,
  deletePayout,
} from '../controllers/artistPayoutController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);

router.route('/').get(getPayouts).post(createPayout);
router.route('/:id').put(updatePayout).delete(deletePayout);
router.route('/:id/approve').put(approvePayout);
router.route('/:id/pay').put(payPayout);

export default router;
