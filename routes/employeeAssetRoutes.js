import express from 'express';
import {
  getEmployeeAssets,
  issueEmployeeAsset,
  updateEmployeeAsset,
  returnEmployeeAsset,
  markEmployeeAssetLost,
  deleteEmployeeAsset,
} from '../controllers/employeeAssetController.js';
import { protect, attachRolePermissions } from '../middleware/authMiddleware.js';

// Mount at /api/employee-assets
const router = express.Router();

router.use(protect, attachRolePermissions);

router.route('/').get(getEmployeeAssets).post(issueEmployeeAsset);
router.post('/:id/return', returnEmployeeAsset);
router.post('/:id/lost', markEmployeeAssetLost);
router.route('/:id').put(updateEmployeeAsset).delete(deleteEmployeeAsset);

export default router;
