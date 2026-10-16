import express from 'express';
import {
  getDocuments,
  uploadDocument,
  updateDocument,
  downloadDocument,
  deleteDocument,
} from '../controllers/employeeDocumentController.js';
import { protect, attachRolePermissions } from '../middleware/authMiddleware.js';
import { uploadDoc } from '../config/cloudinary.js';

const router = express.Router();

router.use(protect, attachRolePermissions);

router.route('/')
  .get(getDocuments)
  .post(uploadDoc.single('file'), uploadDocument);

router.get('/:id/download', downloadDocument);

router.route('/:id')
  .put(uploadDoc.single('file'), updateDocument)
  .delete(deleteDocument);

export default router;
