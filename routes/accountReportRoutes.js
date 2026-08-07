import express from 'express';
import {
  uploadReport,
  getReports,
  deleteReport,
} from '../controllers/accountReportController.js';
import { protect } from '../middleware/authMiddleware.js';
import { uploadDoc } from '../config/cloudinary.js';

const router = express.Router();

router.route('/')
  .get(protect, getReports)
  .post(protect, uploadDoc.single('file'), uploadReport);

router.route('/:id')
  .delete(protect, deleteReport);

export default router;
