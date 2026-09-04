import express from 'express';
import {
  getCollections,
  getPaymentsReceived,
  createCollection,
  verifyCollection,
  deleteCollection,
  updateCollection,
} from '../controllers/collectionController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);

router.get('/payments-received', getPaymentsReceived);
router.route('/').get(getCollections).post(createCollection);
router.route('/:id').put(updateCollection).delete(deleteCollection);
router.route('/:id/verify').put(verifyCollection);

export default router;

