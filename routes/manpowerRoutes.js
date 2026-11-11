import express from 'express';
import {
  getManpowerRequests,
  getAvailability,
  handleManpowerRequest,
  releaseLine,
  allocateHire,
  declineManpowerRequest,
  cancelManpowerRequest,
} from '../controllers/manpowerController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);
router.get('/', getManpowerRequests);
// before /:id
router.get('/availability', getAvailability);
router.post('/:id/handle', handleManpowerRequest);
router.post('/:id/lines/:lineId/release', releaseLine);
router.post('/:id/lines/:lineId/allocate', allocateHire);
router.post('/:id/decline', declineManpowerRequest);
router.post('/:id/cancel', cancelManpowerRequest);

export default router;
