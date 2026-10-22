import express from 'express';
import { selfieUpload } from '../middleware/selfieUpload.js';
import {
  getTryOnStatus,
  grantConsent,
  withdrawConsent,
  createPreview,
  getPreviewImage,
  deletePreview,
} from '../controllers/tryOnController.js';

// Mounted under /api/client/tryon — already behind protectClient (clientRoutes).
const router = express.Router();

router.get('/', getTryOnStatus);
router.post('/consent', grantConsent);
router.delete('/consent', withdrawConsent); // before '/:id'
// Auth runs first (clientRoutes), so anonymous callers never reach the upload.
router.post('/', selfieUpload, createPreview);
router.get('/:id/image', getPreviewImage);
router.delete('/:id', deletePreview);

export default router;
