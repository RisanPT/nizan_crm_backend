import express from 'express';
import asyncHandler from 'express-async-handler';
import { protect } from '../middleware/authMiddleware.js';
import { canEnterCreative } from '../controllers/contentController.js';
import { getFolder, getMediaLink, streamMedia } from '../controllers/marketingMediaController.js';

// Gallery videos played through our server (controllers/marketingMediaController.js). Mounted BEFORE /api/marketing (whose router asks
// for a login on everything that reaches it): the stream is opened by a <video> tag, which carries the signed token, not a login.

const router = express.Router();

router.get('/stream/:token', asyncHandler(streamMedia));

const marketingOnly = asyncHandler(async (req, res, next) => {
  if (await canEnterCreative(req.user)) return next(); // Marketing, or the Creative Director
  res.status(403);
  throw new Error('Only the Marketing team can open the gallery.');
});

router.get('/link', protect, marketingOnly, asyncHandler(getMediaLink));
// what is inside a Dropbox folder link (an artist's footage folder) — listed through the server's Dropbox app when it has one
router.get('/folder', protect, marketingOnly, asyncHandler(getFolder));

export default router;
