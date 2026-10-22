import express from 'express';
import { protect, attachRolePermissions } from '../middleware/authMiddleware.js';
import { protectClient } from '../middleware/clientAuthMiddleware.js';
import { chatUpload } from '../middleware/chatUpload.js';
import {
  getClientConversation,
  postClientMessage,
  markClientRead,
  getClientUnread,
  getConversations,
  getConversationMessages,
  postStaffMessage,
  markStaffRead,
  getUnreadCount,
  canSeeClientChat,
} from '../controllers/chatController.js';

const router = express.Router();

// Client side — authenticated with a client token.
router.get('/client/conversation', protectClient, getClientConversation);
router.get('/client/unread', protectClient, getClientUnread);
router.post('/client/messages', protectClient, chatUpload, postClientMessage);
router.post('/client/read', protectClient, markClientRead);

// Staff side — authenticated with a staff token + chat-staff guard.
const chatStaffGuard = (req, res, next) => {
  if (!canSeeClientChat(req.user)) {
    return res.status(403).json({ message: 'Not allowed' });
  }
  next();
};

router.get('/unread-count', protect, attachRolePermissions, chatStaffGuard, getUnreadCount);
router.get('/conversations', protect, attachRolePermissions, chatStaffGuard, getConversations);
router.get('/conversations/:id/messages', protect, attachRolePermissions, chatStaffGuard, getConversationMessages);
router.post('/conversations/:id/messages', protect, attachRolePermissions, chatStaffGuard, chatUpload, postStaffMessage);
router.post('/conversations/:id/read', protect, attachRolePermissions, chatStaffGuard, markStaffRead);

export default router;
