// Public website API — no login (Team N Makeovers website). Read-only except the
// enquiry form and the anonymous page-view counter.
import express from 'express';
import {
  getAvailabilityDate,
  getAvailabilityMonth,
  getContent,
  getGallery,
  getLocations,
  getPackages,
} from '../controllers/website/publicController.js';
import { submitEnquiry } from '../controllers/website/enquiryController.js';
import { getPreviewContent } from '../controllers/website/previewController.js';
import { recordVisit } from '../controllers/website/visitController.js';

const router = express.Router();

router.get('/content', getContent);
router.get('/gallery', getGallery);
router.get('/packages', getPackages);
router.get('/locations', getLocations); // regions → districts for location pricing
router.get('/availability', getAvailabilityMonth);
router.get('/availability/:date', getAvailabilityDate);
router.get('/preview', getPreviewContent); // drafts, with a staff preview token
router.post('/enquiry', submitEnquiry); // booking + contact forms → Lead (rate-limited)
router.post('/visit', recordVisit); // anonymous page-view counter (always 204)

export default router;
