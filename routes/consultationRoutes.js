import express from 'express';
import {
  cancelConsultation,
  completeConsultation,
  consultationGuard,
  createConsultation,
  getConsultationById,
  getConsultations,
  getLeadConsultations,
  getStylists,
  getSummary,
  markInviteSent,
  markNoShow,
  rescheduleConsultation,
  searchLeads,
  updateConsultation,
  validateTextFields,
  addReferenceImages,
  updateReferenceImage,
  removeReferenceImage,
} from '../controllers/consultationController.js';
import { attachRolePermissions, protect } from '../middleware/authMiddleware.js';
import { consultationImageUpload } from '../middleware/consultationImageUpload.js';

const router = express.Router();

router.use(protect, attachRolePermissions, consultationGuard, validateTextFields);

router.route('/').get(getConsultations).post(createConsultation);

// Fixed paths must come before '/:id'.
router.get('/summary', getSummary);
router.get('/stylists', getStylists);
router.get('/leads/search', searchLeads);
router.get('/lead/:leadId', getLeadConsultations);

router.route('/:id').get(getConsultationById).put(updateConsultation);
router.patch('/:id/reschedule', rescheduleConsultation);
router.patch('/:id/invite-sent', markInviteSent);
router.patch('/:id/cancel', cancelConsultation);
router.patch('/:id/no-show', markNoShow);
router.patch('/:id/complete', completeConsultation);

// Reference photos the client shared.
router.post('/:id/images', consultationImageUpload, addReferenceImages);
router.patch('/:id/images/:imageId', updateReferenceImage);
router.delete('/:id/images/:imageId', removeReferenceImage);

export default router;
