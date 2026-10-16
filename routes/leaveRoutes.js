import express from 'express';
import { protect, attachRolePermissions } from '../middleware/authMiddleware.js';
import {
  getLeaveTypes,
  createLeaveType,
  updateLeaveType,
  deleteLeaveType,
  seedLeaveTypes,
  applyLeave,
  getMyLeave,
  getLeaveRequests,
  cancelLeave,
  getBalances,
  getHolidays,
  createHoliday,
  deleteHoliday,
  getCompOffs,
  createCompOff,
  getLeavePayrollFeed,
} from '../controllers/leaveController.js';

const router = express.Router();

// attachRolePermissions so canManageLeave() can honour the `leave`/`staff`
// features an admin granted a custom role (not just hard-coded role keys).
router.use(protect, attachRolePermissions);

// Leave types
router.get('/types', getLeaveTypes);
router.post('/types', createLeaveType);
router.post('/types/seed', seedLeaveTypes);
router.put('/types/:id', updateLeaveType);
router.delete('/types/:id', deleteLeaveType);

// Requests
router.get('/mine', getMyLeave);
router.get('/requests', getLeaveRequests);
router.post('/apply', applyLeave);
router.post('/:id/cancel', cancelLeave);

// Balances
router.get('/balances', getBalances);

// Holidays
router.get('/holidays', getHolidays);
router.post('/holidays', createHoliday);
router.delete('/holidays/:id', deleteHoliday);

// Compensatory off
router.get('/comp-offs', getCompOffs);
router.post('/comp-offs', createCompOff);

// Payroll feed
router.get('/payroll-feed', getLeavePayrollFeed);

export default router;
