import express from 'express';
import { protect, admin } from '../middleware/authMiddleware.js';
import {
  getRoles,
  createRole,
  updateRole,
  deleteRole,
  getPermissionCatalogue,
} from '../controllers/roleController.js';

const router = express.Router();

// GET /roles is readable by any authenticated user (e.g. for role dropdowns)
router.get('/', protect, getRoles);

// Other endpoints are restricted to administrators only
router.get('/permissions', protect, admin, getPermissionCatalogue);
router.post('/', protect, admin, createRole);
router.route('/:id')
  .put(protect, admin, updateRole)
  .delete(protect, admin, deleteRole);

export default router;
