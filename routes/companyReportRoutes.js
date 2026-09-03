import express from 'express';
import {
  uploadReport,
  getReports,
  updateReport,
  downloadReport,
  deleteReport,
  listFolders,
  createFolder,
  updateFolder,
  deleteFolder,
} from '../controllers/companyReportController.js';
import { protect } from '../middleware/authMiddleware.js';
import { uploadDoc } from '../config/cloudinary.js';

const router = express.Router();

// Folders (must be declared before the '/:id' routes so 'folders' isn't
// captured as an :id).
router.route('/folders')
  .get(protect, listFolders)
  .post(protect, createFolder);
router.route('/folders/:id')
  .put(protect, updateFolder)
  .delete(protect, deleteFolder);

router.route('/')
  .get(protect, getReports)
  .post(protect, uploadDoc.single('file'), uploadReport);

router.get('/:id/download', protect, downloadReport);

router.route('/:id')
  .put(protect, uploadDoc.single('file'), updateReport)
  .delete(protect, deleteReport);

export default router;
