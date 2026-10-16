import express from 'express';
import { getSummary } from '../controllers/hrAnalyticsController.js';
import { protect, attachRolePermissions } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect, attachRolePermissions);

router.get('/summary', getSummary);

export default router;
