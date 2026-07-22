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

// Only administrators may view or change the permission matrix.
router.use(protect, admin);

router.get('/permissions', getPermissionCatalogue);
router.route('/').get(getRoles).post(createRole);
router.route('/:id').put(updateRole).delete(deleteRole);

export default router;
