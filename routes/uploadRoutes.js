import express from 'express';
import { upload } from '../config/cloudinary.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.post('/', protect, (req, res, next) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      console.error('Upload middleware error:', err);
      let errMsg = 'Failed to upload image. Please make sure it is a valid format.';
      if (typeof err === 'string') {
        errMsg = err;
      } else if (err && typeof err === 'object') {
        errMsg = err.message || (err.error && err.error.message) || err.error || errMsg;
      }
      return res.status(400).json({ message: errMsg });
    }
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }
    res.json({
      url: req.file.path,
      public_id: req.file.filename
    });
  });
});

export default router;
