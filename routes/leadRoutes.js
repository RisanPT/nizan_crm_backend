import express from 'express';
import { getLeads, createLead, updateLead, deleteLead } from '../controllers/leadController.js';
import { protect } from '../middleware/authMiddleware.js';
import leadActivityRoutes from './leadActivityRoutes.js';

const router = express.Router();

router.use(protect);

// Mount activities nested router
router.use('/:leadId/activities', leadActivityRoutes);

router.route('/').get(getLeads).post(createLead);
router.route('/:id').put(updateLead).delete(deleteLead);

export default router;
