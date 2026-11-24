import express from 'express';
import { protect, attachRolePermissions } from '../middleware/authMiddleware.js';
import { hrWideOnly } from '../middleware/hrWideOnly.js';
import {
  getHrStaff,
  getHrAttendance,
  getHrLeaves,
  getHrHolidays,
} from '../controllers/hrBridgeController.js';

const router = express.Router();

// All HR bridge routes require a logged-in CRM user.
// The actual PHP authentication is handled by the shared API key
// in hrBridgeController — the Flutter user never sees it.
// Any user's attendance / leave by user_id, plus the staff list: HR-wide only
// (2026-11-24). It used to be open to any logged-in user.
router.use(protect, attachRolePermissions, hrWideOnly(['staff.attendance']));

// GET /api/hr/staff              → admin/management/HR employees from PHP
// GET /api/hr/attendance?user_id=&year=&month=
// GET /api/hr/leaves?user_id=&year=&month=
// GET /api/hr/holidays?year=&month=
router.get('/staff',      getHrStaff);
router.get('/attendance', getHrAttendance);
router.get('/leaves',     getHrLeaves);
router.get('/holidays',   getHrHolidays);

export default router;
