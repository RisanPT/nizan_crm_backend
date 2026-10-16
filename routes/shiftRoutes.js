import express from 'express';
import {
  getShifts,
  createShift,
  updateShift,
  deleteShift,
  getAssignments,
  createAssignment,
  deleteAssignment,
} from '../controllers/shiftController.js';
import { protect, attachRolePermissions } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect, attachRolePermissions);

// Assignments declared before '/:id' so 'assignments' isn't captured as an :id.
router.route('/assignments').get(getAssignments).post(createAssignment);
router.delete('/assignments/:id', deleteAssignment);

router.route('/').get(getShifts).post(createShift);
router.route('/:id').put(updateShift).delete(deleteShift);

export default router;
