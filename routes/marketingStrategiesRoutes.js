import express from 'express';
import asyncHandler from 'express-async-handler';
import { protect } from '../middleware/authMiddleware.js';
import { attachMarketingAccess } from '../controllers/marketingEodController.js';
import { canManageMarketing } from '../controllers/contentController.js';
import {
  getSetup, getOverview, listPlans, createPlan, updatePlan, deletePlan,
  listProjects, getProject, createProject, updateProject, deleteProject,
  listInitiatives, getInitiative, createInitiative, updateInitiative, deleteInitiative,
  getRoadmap, createRoadmapItem, updateRoadmapItem, deleteRoadmapItem, tickRoadmapItem,
  listFindings, createFinding, updateFinding, deleteFinding,
  listReviews, createReview, updateReview, deleteReview, updateReviewAction,
} from '../controllers/marketingStrategiesController.js';

// /api/marketing/strategies — Strategies & Developments (Overview, Strategic Plans, Development Projects, Roadmap, Initiatives, Research & Insights, Reviews).
// Marketing roles only (the same gate as /api/content); the CEO / Executive Director read it through the leadership guard.
// Read: every Marketing user. Write: managers / admin (plans, projects, roadmap lines, reviews, statuses, deletes); members create and update
// the initiatives they own, tick roadmap lines, add findings and tick their own review action items (see the controller's header).
const router = express.Router();
router.use(protect);
router.use(attachMarketingAccess);
router.use(
  asyncHandler(async (req, res, next) => {
    if (await canManageMarketing(req.user)) return next();
    res.status(403);
    throw new Error('Only the Marketing team can open this.');
  }),
);

router.get('/setup', getSetup);
router.get('/overview', getOverview);

router.route('/plans').get(listPlans).post(createPlan);
router.route('/plans/:id').put(updatePlan).delete(deletePlan);

router.route('/projects').get(listProjects).post(createProject);
router.route('/projects/:id').get(getProject).put(updateProject).delete(deleteProject);

router.route('/initiatives').get(listInitiatives).post(createInitiative);
router.route('/initiatives/:id').get(getInitiative).put(updateInitiative).delete(deleteInitiative);

router.route('/roadmap').get(getRoadmap).post(createRoadmapItem);
router.post('/roadmap/:id/tick', tickRoadmapItem);
router.route('/roadmap/:id').put(updateRoadmapItem).delete(deleteRoadmapItem);

router.route('/research').get(listFindings).post(createFinding);
router.route('/research/:id').put(updateFinding).delete(deleteFinding);

router.route('/reviews').get(listReviews).post(createReview);
router.patch('/reviews/:id/actions/:actionId', updateReviewAction);
router.route('/reviews/:id').put(updateReview).delete(deleteReview);

export default router;
