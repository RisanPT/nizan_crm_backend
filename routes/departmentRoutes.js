import express from 'express';
import {
  getDepartments,
  getDepartmentMembers,
  seedDepartments,
  assignStaffByRole,
  createDepartment,
  updateDepartment,
  deleteDepartment,
} from '../controllers/departmentController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.get('/', protect, getDepartments);
router.post('/seed', protect, seedDepartments);
router.post('/assign-by-role', protect, assignStaffByRole);
router.get('/:id/members', protect, getDepartmentMembers);
router.post('/', protect, createDepartment);
router.put('/:id', protect, updateDepartment);
router.delete('/:id', protect, deleteDepartment);

export default router;
