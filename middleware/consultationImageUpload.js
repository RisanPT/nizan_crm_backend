import multer from 'multer';
import { MAX_REFERENCE_IMAGES, MAX_REFERENCE_IMAGE_BYTES } from '../utils/consultationRules.js';

// Consultation reference photos (field `images`). Buffered in memory and
// streamed to Cloudinary by utils/consultationImages.js — nothing touches
// disk. Mounted after the auth + consultation guards, so anonymous callers
// can't make the server buffer uploads. The real file type is checked again
// in the controller (sniffImageMime).

const IMAGE_MIME = /^image\/(jpe?g|png|webp)$/;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_REFERENCE_IMAGE_BYTES, files: MAX_REFERENCE_IMAGES },
  fileFilter: (req, file, cb) => {
    const mime = String(file.mimetype || '').split(';')[0].trim().toLowerCase();
    if (IMAGE_MIME.test(mime)) return cb(null, true);
    return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname), false);
  },
});

export const consultationImageUpload = (req, res, next) => {
  upload.array('images', MAX_REFERENCE_IMAGES)(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res
        .status(413)
        .json({ message: `Each image must be under ${MAX_REFERENCE_IMAGE_BYTES / 1024 / 1024} MB.` });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({ message: `Add at most ${MAX_REFERENCE_IMAGES} images at a time.` });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(415).json({ message: 'Only JPEG, PNG or WebP images can be added.' });
    }
    return res.status(400).json({ message: 'Could not read those images.' });
  });
};
