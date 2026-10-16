import express from 'express';
import {
  getJobPosts,
  createJobPost,
  updateJobPost,
  deleteJobPost,
  getCandidates,
  createCandidate,
  bulkImportCandidates,
  updateCandidate,
  deleteCandidate,
  getOffers,
  createOffer,
  updateOffer,
  deleteOffer,
  acceptOffer,
  declineOffer,
  getJobRoles,
  createJobRole,
  updateJobRole,
  deleteJobRole,
  getHiringPlans,
  createHiringPlan,
  updateHiringPlan,
  raiseHiringPlan,
  approveHiringPlan,
  rejectHiringPlan,
  deleteHiringPlan,
  incomingApplicantWebhook,
  metaWebhookVerify,
  metaWebhookReceive,
  getJobPostSocialCopy,
  getRecruitmentWebhookConfig,
} from '../controllers/recruitmentController.js';
import { protect, attachRolePermissions } from '../middleware/authMiddleware.js';

const router = express.Router();

// ── Public Webhooks (Unauthenticated, verified via secret / Meta challenge) ──
router.get('/webhooks/meta', metaWebhookVerify);
router.post('/webhooks/meta', metaWebhookReceive);
router.post('/webhooks/incoming-applicant', incomingApplicantWebhook);

router.use(protect, attachRolePermissions);

// Webhook config & social copy routes
router.get('/webhook-config', getRecruitmentWebhookConfig);
router.get('/job-posts/:id/social-copy', getJobPostSocialCopy);

// Organizational Job Roles & Hierarchy (FR-1.1 - FR-1.3)
router.route('/roles').get(getJobRoles).post(createJobRole);
router.route('/roles/:id').put(updateJobRole).delete(deleteJobRole);

// Hiring Plans / Requisitions (FR-1.1 - FR-1.5)
router.route('/plans').get(getHiringPlans).post(createHiringPlan);
router.route('/plans/:id').put(updateHiringPlan).delete(deleteHiringPlan);
router.post('/plans/:id/raise', raiseHiringPlan);
router.post('/plans/:id/approve', approveHiringPlan);
router.post('/plans/:id/reject', rejectHiringPlan);

router.route('/job-posts').get(getJobPosts).post(createJobPost);
router.route('/job-posts/:id').put(updateJobPost).delete(deleteJobPost);

router.route('/candidates').get(getCandidates).post(createCandidate);
router.post('/candidates/bulk-import', bulkImportCandidates);
router.route('/candidates/:id').put(updateCandidate).delete(deleteCandidate);

router.route('/offers').get(getOffers).post(createOffer);
router.route('/offers/:id').put(updateOffer).delete(deleteOffer);
router.post('/offers/:id/accept', acceptOffer);
router.post('/offers/:id/decline', declineOffer);

export default router;
