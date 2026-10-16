import multer from 'multer';

// Selfie for "preview on me". Held in memory only — never written to disk or
// stored anywhere (see controllers/tryOnController.js).

export const MAX_SELFIE_BYTES = 6 * 1024 * 1024; // 6 MB

const ALLOWED = /^image\/(jpe?g|png|webp)$/;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SELFIE_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED.test(String(file.mimetype || '').toLowerCase())) return cb(null, true);
    return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname), false);
  },
});

/// The declared Content-Type is client-controlled, so check the real file
/// signature too. Returns the true mime type, or null if it isn't a JPEG/PNG/WebP.
export const sniffImageMime = (buf) => {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
};

export const selfieUpload = (req, res, next) => {
  upload.single('selfie')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ message: `That photo is too large (max ${MAX_SELFIE_BYTES / 1024 / 1024} MB).` });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(415).json({ message: 'Please use a JPEG, PNG or WebP photo.' });
    }
    return res.status(400).json({ message: 'Could not read that photo.' });
  });
};
