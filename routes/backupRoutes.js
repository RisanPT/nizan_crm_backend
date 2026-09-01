import express from 'express';
import {
  getBackupTargets, backupDepartment, backupFull,
} from '../controllers/backupController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();
router.use(protect);

router.get('/departments', getBackupTargets);
router.get('/full', backupFull);
router.get('/department/:department', backupDepartment);

export default router;
