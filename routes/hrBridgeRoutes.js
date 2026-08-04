import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
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
router.use(protect);

// GET /api/hr/staff              → admin/management/HR employees from PHP
// GET /api/hr/attendance?user_id=&year=&month=
// GET /api/hr/leaves?user_id=&year=&month=
// GET /api/hr/holidays?year=&month=
router.get('/staff',      getHrStaff);
router.get('/attendance', getHrAttendance);
router.get('/leaves',     getHrLeaves);
router.get('/holidays',   getHrHolidays);

export default router;
