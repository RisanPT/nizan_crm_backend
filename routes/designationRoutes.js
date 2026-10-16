import express from 'express';
import {
  getDesignations,
  createDesignation,
  updateDesignation,
  deleteDesignation,
} from '../controllers/designationController.js';
import { protect, attachRolePermissions } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect, attachRolePermissions);

router.route('/').get(getDesignations).post(createDesignation);
router.route('/:id').put(updateDesignation).delete(deleteDesignation);

export default router;
