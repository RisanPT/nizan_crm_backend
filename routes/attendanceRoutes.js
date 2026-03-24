import express from 'express';
import { getAttendances, markAttendance } from '../controllers/attendanceController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);
router.route('/').get(getAttendances).post(markAttendance);

export default router;
