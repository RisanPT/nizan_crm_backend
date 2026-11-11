import express from 'express';
import { getCeoInbox, getCeoSignals } from '../controllers/ceoController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);
router.get('/inbox', getCeoInbox);
router.get('/signals', getCeoSignals);

export default router;
