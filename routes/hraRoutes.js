import express from 'express';
import { protect, attachRolePermissions } from '../middleware/authMiddleware.js';
import { canManageHra, requireAccess } from '../utils/hrAccess.js';
import {
  getHraRecords,
  getHraStats,
  createHraRecord,
  updateHraRecord,
  deleteHraRecord,
} from '../controllers/hraController.js';

const router = express.Router();

router.use(protect, attachRolePermissions, requireAccess(canManageHra, 'You are not allowed to access HRA'));

router.get('/', getHraRecords);
router.get('/stats', getHraStats);
router.post('/', createHraRecord);
router.put('/:id', updateHraRecord);
router.delete('/:id', deleteHraRecord);

export default router;
