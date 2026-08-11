import express from 'express';
import {
  uploadReport,
  getReports,
  updateReport,
  updateReportAccess,
  downloadReport,
  deleteReport,
} from '../controllers/accountReportController.js';
import { protect } from '../middleware/authMiddleware.js';
import { uploadDoc } from '../config/cloudinary.js';

const router = express.Router();

router.route('/')
  .get(protect, getReports)
  .post(protect, uploadDoc.single('file'), uploadReport);

router.get('/:id/download', protect, downloadReport);
router.put('/:id/access', protect, updateReportAccess);

router.route('/:id')
  .put(protect, uploadDoc.single('file'), updateReport)
  .delete(protect, deleteReport);

export default router;
