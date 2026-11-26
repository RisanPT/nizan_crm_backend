import express from 'express';
import {
  getBlockedDates,
  createBlockedDate,
  updateBlockedDate,
  deleteBlockedDate,
} from '../controllers/blockedDateController.js';
import { protect, attachRolePermissions } from '../middleware/authMiddleware.js';
import { hasPerm } from '../utils/hrAccess.js';

const router = express.Router();

router.get('/', getBlockedDates);

// Adding / changing blocked dates changes what can be booked: the same people
// who edit Slot Capacity (admin, manager, hr) or hold staff.slots — not any
// login (2026-11-26).
const canEditBlockedDates = (req, res, next) => {
  const role = String(req.user?.role || '').trim().toLowerCase();
  if (['admin', 'manager', 'hr'].includes(role) || hasPerm(req.user, 'staff.slots')) return next();
  return res.status(403).json({ message: 'You are not allowed to change blocked dates' });
};

router.use(protect, attachRolePermissions, canEditBlockedDates);
router.post('/', createBlockedDate);
router.put('/:id', updateBlockedDate);
router.delete('/:id', deleteBlockedDate);

export default router;
