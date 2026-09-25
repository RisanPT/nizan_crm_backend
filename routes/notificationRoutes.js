import express from 'express';
import {
  getNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
  clearOne,
  clearAll,
} from '../controllers/notificationController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);

router.get('/', getNotifications);
router.get('/unread-count', getUnreadCount);
router.patch('/read-all', markAllRead);
router.patch('/clear-all', clearAll);
router.patch('/:id/read', markRead);
router.patch('/:id/clear', clearOne);

export default router;
