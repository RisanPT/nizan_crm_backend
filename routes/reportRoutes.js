import express from 'express';
import { getFinanceReport } from '../controllers/reportController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.get('/finance', protect, getFinanceReport);

export default router;
