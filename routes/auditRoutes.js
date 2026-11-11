import express from 'express';
import { getAuditLogs } from '../controllers/auditController.js';
import { protect, attachRolePermissions } from '../middleware/authMiddleware.js';
import { canSeeAllEmployeePay, requireAccess } from '../utils/hrAccess.js';

const router = express.Router();

// The change log carries pay / bank history: company-wide pay access only.
router.use(protect, attachRolePermissions, requireAccess(canSeeAllEmployeePay, 'You are not allowed to view the change log'));

router.get('/', getAuditLogs);

export default router;
