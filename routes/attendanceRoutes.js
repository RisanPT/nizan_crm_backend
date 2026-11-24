import express from 'express';
import { getAttendances, markAttendance } from '../controllers/attendanceController.js';
import { protect, attachRolePermissions } from '../middleware/authMiddleware.js';
import { hrWideOnly } from '../middleware/hrWideOnly.js';

const router = express.Router();

// Every employee's attendance: HR-wide only (2026-11-24). It used to be open to
// any logged-in user, including creating records for anyone.
router.use(protect, attachRolePermissions, hrWideOnly(['staff.attendance']));
router.route('/').get(getAttendances).post(markAttendance);

export default router;
