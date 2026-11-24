import multer from 'multer';
import { UPLOAD_RULES } from '../config/websiteUploadRules.js';

// Team N Website image uploads. One file in the `file` field, held in memory
// (never written to disk) so it can be checked byte-by-byte before it goes to
// Cloudinary. Multer's own cap is the largest rule; the exact per-field limit
// is checked afterwards by utils/imageProbe.js.
// Mount AFTER protect so anonymous callers can't make the server buffer files.

export const MAX_WEBSITE_UPLOAD_BYTES = Math.max(...Object.values(UPLOAD_RULES).map((r) => r.maxBytes));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_WEBSITE_UPLOAD_BYTES, files: 1, fields: 5, fieldSize: 1024 },
});

export const websiteUpload = (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (!err) {
      if (!req.file) return res.status(400).json({ message: 'Choose an image to upload (form field "file").' });
      return next();
    }
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ message: `That file is too large (max ${MAX_WEBSITE_UPLOAD_BYTES / 1048576} MB).` });
    }
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ message: 'Upload one image at a time, in the "file" field.' });
    }
    return res.status(400).json({ message: 'Could not read the upload.' });
  });
};
