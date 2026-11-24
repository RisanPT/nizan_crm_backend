import express from 'express';
import multer from 'multer';
import { MAX_PDF_BYTES } from '../utils/shootBoard.js';
import asyncHandler from 'express-async-handler';
import { protect } from '../middleware/authMiddleware.js';
import { attachMarketingAccess } from '../controllers/marketingEodController.js';
import { canManageMarketing } from '../controllers/contentController.js';
import {
  addMoodboard, renameMoodboardItem, removeMoodboard, addCameraRefs, renameCameraRef, removeCameraRef, saveLogistics,
  tickChecklist,
  markFrameShot,
  uploadShootDocument,
  getShootDocument,
  renameShootDocument,
  removeShootDocument,
  listShoots, getShoot, createShoot, updateShoot, deleteShoot, getSetup, getCalendar, getReports, getBookingOptions, getShootOptions, getBookingContent,
} from '../controllers/marketingPortfolioController.js';
import { getQuality, getArtistQuality } from '../controllers/workQualityController.js';

// /api/marketing/portfolio — the Creative Portfolio (Shoot Planner, Production Calendar, Shoot Reports, and a booking's Content card).
// The Gallery reads the shared
// asset library at /api/marketing/socials/assets. Marketing roles only; the CEO / Executive Director read it through the leadership guard.
const router = express.Router();

// a PDF arrives in memory (checked, then kept by services/shootFiles.js) — its own multer, so this router never loads config/cloudinary.js
const pdfMulter = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PDF_BYTES, files: 1 } });
const pdfUpload = (req, res, next) =>
  pdfMulter.single('file')(req, res, (err) => {
    if (err?.code === 'LIMIT_FILE_SIZE') {
      res.status(413);
      return next(new Error('A PDF can be at most 25 MB — make it smaller, or share it as a link.'));
    }
    next(err);
  });
router.use(protect);
router.use(attachMarketingAccess);
router.use(
  asyncHandler(async (req, res, next) => {
    if (await canManageMarketing(req.user)) return next();
    res.status(403);
    throw new Error('Only the Marketing team can open the Creative Portfolio.');
  }),
);

router.get('/setup', getSetup);
// Artist Quality: the clients' reviews of each artist's works, with the works' photos and videos
router.get('/quality', getQuality);
router.get('/quality/artist/:key', getArtistQuality);
router.get('/calendar', getCalendar);
router.get('/reports', getReports);
router.get('/booking-options', getBookingOptions); // works a shoot can be linked to
router.get('/shoot-options', getShootOptions); // shoots a post or an asset can be attached to
router.get('/bookings/:id/content', getBookingContent); // a booking's linked shoots and their content checklist
router.route('/shoots').get(listShoots).post(createShoot);
router.route('/shoots/:id').get(getShoot).put(updateShoot).delete(deleteShoot);
// the moodboard (pictures and links) and Crew & Logistics, changed from their own tabs
router.route('/shoots/:id/moodboard').post(addMoodboard).patch(renameMoodboardItem).delete(removeMoodboard);
// Camera Movement: its reference pictures and video links (its PDFs: /documents with part=camera)
router.route('/shoots/:id/camera').post(addCameraRefs).patch(renameCameraRef).delete(removeCameraRef);
router.put('/shoots/:id/logistics', saveLogistics);
router.patch('/shoots/:id/logistics/check', tickChecklist); // one checklist line ticked (never undoes another person's tick)
router.patch('/shoots/:id/storyboard/:key', markFrameShot); // one frame ticked as filmed on the shoot day
// PDFs on the moodboard / storyboard: uploaded (25 MB at most), read in the app, renamed, removed
router.post('/shoots/:id/documents', pdfUpload, uploadShootDocument);
router.route('/shoots/:id/documents/:key').get(getShootDocument).patch(renameShootDocument).delete(removeShootDocument);

export default router;
