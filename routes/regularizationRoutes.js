import express from 'express';
import {
  getMine,
  getRequests,
  applyRegularization,
  cancelRegularization,
} from '../controllers/regularizationController.js';
import { protect, attachRolePermissions } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect, attachRolePermissions);

router.get('/mine', getMine);
router.get('/requests', getRequests);
router.post('/', applyRegularization);
router.post('/:id/cancel', cancelRegularization);

export default router;
