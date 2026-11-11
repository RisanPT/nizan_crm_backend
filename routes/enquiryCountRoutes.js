import express from 'express';
import {
  getDayCounts,
  saveDayCounts,
  getVerification,
} from '../controllers/enquiryCountController.js';
import { protect } from '../middleware/authMiddleware.js';

// Manual daily enquiry counts — one shared team count per day per channel
// (see models/EnquiryCount.js).
const router = express.Router();

router.use(protect);

router.get('/day', getDayCounts);
router.put('/day', saveDayCounts);
// Earlier per-person paths, kept as aliases of the shared team count.
router.get('/me', getDayCounts);
router.put('/me', saveDayCounts);
router.get('/verification', getVerification);

export default router;
