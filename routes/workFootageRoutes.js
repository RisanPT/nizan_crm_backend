import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import { attachMarketingAccess } from '../controllers/marketingEodController.js';
import { addFootageLink, checkUpload, getBookingFootage, getInbox, removeFootageLink, setFootageStatus, uploadPage } from '../controllers/workFootageController.js';

// /api/work-footage — footage from works: the artists of a booking hand in its Dropbox link (or upload through the work's Dropbox upload
// page); Marketing sees it all in Creative Portfolio → Footage. Each handler checks who may (the booking's artists, or Marketing).
const router = express.Router();
router.use(protect);
router.use(attachMarketingAccess);

router.get('/inbox', getInbox);
router.get('/booking/:bookingId', getBookingFootage);
router.post('/booking/:bookingId/links', addFootageLink);
router.delete('/booking/:bookingId/links/:linkId', removeFootageLink);
router.post('/booking/:bookingId/upload-page', uploadPage);
router.post('/booking/:bookingId/check', checkUpload);
router.patch('/:id', setFootageStatus);

export default router;
