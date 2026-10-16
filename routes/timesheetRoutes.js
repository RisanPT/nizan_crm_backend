import express from 'express';
import {
  getMyTimesheets,
  getTimesheets,
  saveTimesheet,
  submitTimesheet,
  deleteTimesheet,
} from '../controllers/timesheetController.js';
import { protect, attachRolePermissions } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect, attachRolePermissions);

router.get('/mine', getMyTimesheets);
router.get('/requests', getTimesheets);
router.post('/', saveTimesheet);
router.post('/:id/submit', submitTimesheet);
router.delete('/:id', deleteTimesheet);

export default router;
