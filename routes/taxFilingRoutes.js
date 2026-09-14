import express from 'express';
import { getTaxFilings, upsertTaxFiling } from '../controllers/taxFilingController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);

router.route('/').get(getTaxFilings).put(upsertTaxFiling);

export default router;
