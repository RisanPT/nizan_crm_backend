import express from 'express';
import { protect, attachRolePermissions } from '../middleware/authMiddleware.js';
import {
  getApprovalInbox,
  getMyApprovals,
  getApprovalHistory,
  approveApproval,
  rejectApproval,
} from '../controllers/approvalController.js';

const router = express.Router();

router.use(protect, attachRolePermissions);

router.get('/inbox', getApprovalInbox);
router.get('/mine', getMyApprovals);
router.get('/history', getApprovalHistory);
router.post('/:id/approve', approveApproval);
router.post('/:id/reject', rejectApproval);

export default router;
