import express from 'express';
import {
  getLeads,
  getLeadClusters,
  getLeadsReport,
  createLead,
  updateLead,
  deleteLead,
  bulkAssignLeads,
  requestLostApproval,
  reviewLostApproval,
} from '../controllers/leadController.js';
import { protect } from '../middleware/authMiddleware.js';
import leadActivityRoutes from './leadActivityRoutes.js';

const router = express.Router();

router.use(protect);

// Mount activities nested router
router.use('/:leadId/activities', leadActivityRoutes);

router.route('/').get(getLeads).post(createLead);
// Demand-pileup clusters (same event date + same place). Static path, so it is
// declared before the '/:id' routes.
router.get('/clusters', getLeadClusters);
// Day / week / month lead report (marketing). Static path — before '/:id'.
router.get('/report', getLeadsReport);
router.post('/bulk-assign', bulkAssignLeads);
// Lost-approval workflow
router.post('/:id/request-lost', requestLostApproval);
router.post('/:id/review-lost', reviewLostApproval);
router.route('/:id').put(updateLead).delete(deleteLead);

export default router;
