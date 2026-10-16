import express from 'express';
import {
  getCourses,
  createCourse,
  updateCourse,
  deleteCourse,
  getMyEnrollments,
  getEnrollments,
  enroll,
  updateEnrollment,
  deleteEnrollment,
  getOrientationPlans,
  createOrientationPlan,
  updateOrientationPlan,
  getActiveOrientations,
  assignOrientation,
  updateOrientationProgress,
} from '../controllers/lmsController.js';
import { protect, attachRolePermissions } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect, attachRolePermissions);

router.route('/courses').get(getCourses).post(createCourse);
router.route('/courses/:id').put(updateCourse).delete(deleteCourse);

router.get('/enrollments/mine', getMyEnrollments);
router.get('/enrollments', getEnrollments);
router.post('/enroll', enroll);
router.route('/enrollments/:id').put(updateEnrollment).delete(deleteEnrollment);

// ── Orientation Plans (1-Week Doc & Syllabus) & Active Tracking
router.route('/orientations/plans').get(getOrientationPlans).post(createOrientationPlan);
router.route('/orientations/plans/:id').put(updateOrientationPlan);
router.route('/orientations/active').get(getActiveOrientations);
router.route('/orientations/assign').post(assignOrientation);
router.route('/orientations/active/:id').put(updateOrientationProgress);

export default router;
