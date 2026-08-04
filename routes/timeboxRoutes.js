import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import {
  getTimeboxEmployees,
  getTimeboxAttendance,
  getAttendanceSummary,
  getTimeboxDays,
  getPayrollPreview,
  generatePayrollFromAttendance,
  syncEmployees,
} from '../controllers/timeboxController.js';

const router = express.Router();

// All Timebox routes require a logged-in CRM user. The Timebox API key is
// applied server-side in services/timeboxClient.js — never exposed to clients.
router.use(protect);

// HR — directory + attendance
router.get('/employees', getTimeboxEmployees);
router.get('/attendance', getTimeboxAttendance);              // ?from=&to=&employee_id=
router.get('/attendance-summary', getAttendanceSummary);     // ?from=&to=
router.get('/days', getTimeboxDays);                         // ?from=&to=&employee_id=

// Sync — write Timebox IDs back onto CRM employees for stable matching
router.post('/sync-employees', syncEmployees);

// Accounts — attendance-driven payroll
router.get('/payroll-preview', getPayrollPreview);           // ?from=&to=
router.post('/generate-payroll', generatePayrollFromAttendance);

export default router;
