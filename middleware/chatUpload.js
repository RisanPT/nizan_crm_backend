import multer from 'multer';

// Concierge-chat attachments (photos + voice notes). Files are buffered in
// memory and streamed to Cloudinary by utils/chatMedia.js — nothing touches disk.
//
// Mounted AFTER the auth middleware so anonymous callers can't make the server
// buffer uploads. Non-multipart (plain JSON text) requests pass straight
// through, so the original text-only API keeps working.

export const MAX_CHAT_FILE_BYTES = 8 * 1024 * 1024; // 8 MB per file
export const MAX_CHAT_FILES = 6;

const IMAGE_MIME = /^image\/(jpe?g|png|webp|heic|heif|gif)$/;
// Browsers record audio/webm (Chrome/Firefox) or audio/mp4 (Safari); phones
// record AAC in an .m4a (audio/mp4) container.
const AUDIO_MIME = /^audio\/(mp4|x-m4a|m4a|aac|mpeg|mp3|ogg|webm|wav|x-wav|3gpp|amr)$/;

/// "audio/webm;codecs=opus" -> "audio/webm"
export const baseMime = (mime) => String(mime || '').split(';')[0].trim().toLowerCase();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CHAT_FILE_BYTES, files: MAX_CHAT_FILES },
  fileFilter: (req, file, cb) => {
    const mime = baseMime(file.mimetype);
    if (IMAGE_MIME.test(mime) || AUDIO_MIME.test(mime)) return cb(null, true);
    return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname), false);
  },
});

/// Accepts up to 6 files in the `files` field and answers upload problems with a
/// clean 4xx instead of a stack trace.
export const chatUpload = (req, res, next) => {
  upload.array('files', MAX_CHAT_FILES)(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ message: `That file is too large (max ${MAX_CHAT_FILE_BYTES / 1024 / 1024} MB).` });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({ message: `You can send up to ${MAX_CHAT_FILES} files at once.` });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(415).json({ message: 'Only photos and voice messages can be sent.' });
    }
    return res.status(400).json({ message: 'Could not read the attachment.' });
  });
};
