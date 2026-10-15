import express from 'express';
import {
  getMine,
  getRequests,
  submitClaim,
  cancelClaim,
  payClaim,
  deleteClaim,
} from '../controllers/reimbursementController.js';
import { protect, attachRolePermissions } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect, attachRolePermissions);

router.get('/mine', getMine);
router.get('/requests', getRequests);
router.post('/', submitClaim);
router.post('/:id/cancel', cancelClaim);
router.post('/:id/pay', payClaim);
router.delete('/:id', deleteClaim);

export default router;
