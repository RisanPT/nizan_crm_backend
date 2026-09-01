import express from 'express';
import {
  getContentItems, createContentItem, updateContentItem, deleteContentItem, getContentStats,
} from '../controllers/contentController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();
router.use(protect);

router.get('/stats', getContentStats); // before /:id
router.route('/').get(getContentItems).post(createContentItem);
router.route('/:id').put(updateContentItem).delete(deleteContentItem);

export default router;
