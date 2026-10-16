import express from 'express';
import {
  getAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
} from '../controllers/engagementController.js';
import { protect, attachRolePermissions } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect, attachRolePermissions);

router.route('/').get(getAnnouncements).post(createAnnouncement);
router.route('/:id').put(updateAnnouncement).delete(deleteAnnouncement);

export default router;
