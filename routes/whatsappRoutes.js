import express from 'express';
import multer from 'multer';
import { protect, admin } from '../middleware/authMiddleware.js';
import {
  getWhatsAppStatus,
  pingWhatsApp,
  sendWhatsAppDocument,
  getWhatsAppHistory,
} from '../controllers/whatsappController.js';

// PDFs only, held in memory just long enough to forward (TeamN Chat max 100 MB).
const pdfUpload = multer({
  storage: multer.memoryStorage(),
  // fieldSize: the print HTML (with its inline logo) can arrive as a field.
  limits: { fileSize: 100 * 1024 * 1024, files: 1, fieldSize: 10 * 1024 * 1024 },
});

// Turn multer errors into the same { ok, error } shape the app shows.
const singlePdf = (req, res, next) =>
  pdfUpload.single('file')(req, res, (err) => {
    if (!err) return next();
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    res.status(tooBig ? 413 : 400).json({
      ok: false,
      error: tooBig ? 'The PDF is larger than 100 MB.' : `Upload failed: ${err.message}`,
    });
  });

const router = express.Router();

router.use(protect);

router.get('/status', getWhatsAppStatus);
router.get('/ping', admin, pingWhatsApp);
router.get('/history', getWhatsAppHistory);
router.post('/:mode(handover|send)', singlePdf, sendWhatsAppDocument);

export default router;
