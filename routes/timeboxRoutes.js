import express from 'express';
import { protect, attachRolePermissions } from '../middleware/authMiddleware.js';
import {
  getTimeboxEmployees,
  getTimeboxAttendance,
  getAttendanceSummary,
  getTimeboxDays,
  getPayrollPreview,
  generatePayrollFromAttendance,
  syncEmployees,
} from '../controllers/timeboxController.js';
import { canSeeAttendance, canManagePayroll, canManageStaff, requireAccess } from '../utils/hrAccess.js';

const router = express.Router();

// All Timebox routes require a logged-in CRM user. The Timebox API key is
// applied server-side in services/timeboxClient.js — never exposed to clients.
router.use(protect, attachRolePermissions);

const attendance = requireAccess(canSeeAttendance, 'You are not allowed to view attendance');
const payroll = requireAccess(canManagePayroll, 'You are not allowed to run payroll');
const staff = requireAccess(canManageStaff, 'You are not allowed to manage staff');

// HR — directory + attendance
router.get('/employees', attendance, getTimeboxEmployees);
router.get('/attendance', attendance, getTimeboxAttendance);              // ?from=&to=&employee_id=
router.get('/attendance-summary', attendance, getAttendanceSummary);     // ?from=&to=
router.get('/days', attendance, getTimeboxDays);                         // ?from=&to=&employee_id=

// Sync — write Timebox IDs back onto CRM employees for stable matching
router.post('/sync-employees', staff, syncEmployees);

// Accounts — attendance-driven payroll
router.get('/payroll-preview', payroll, getPayrollPreview);           // ?from=&to=
router.post('/generate-payroll', payroll, generatePayrollFromAttendance);

export default router;
