import express from 'express';
import {
  getCollections,
  createCollection,
  verifyCollection,
  deleteCollection,
} from '../controllers/collectionController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);

router.route('/').get(getCollections).post(createCollection);
router.route('/:id').delete(deleteCollection);
router.route('/:id/verify').put(verifyCollection);

export default router;
