import express from 'express';
import {
  getProjects,
  getProjectById,
  createProject,
  updateProject,
  deleteProject,
  respondToInvitation,
  resendInvitation,
  approveProject,
  rejectProject,
  updateCost,
  raiseProjectCost,
  decideCost,
  getPendingCosts,
  getProjectSpend,
  getChargeableProjects,
  updateProjectTeam,
} from '../controllers/projectController.js';
import { createManpowerRequest, getProjectTeam } from '../controllers/manpowerController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);
router.route('/').get(getProjects).post(createProject);
// Finance's list of costs waiting for a decision (before /:id, which would take "cost" for an id)
router.get('/cost/pending', getPendingCosts);
// The projects an expense can be charged to (also before /:id)
router.get('/chargeable', getChargeableProjects);
router.route('/:id').get(getProjectById).put(updateProject).delete(deleteProject);
// A department answers its invitation; a proposal is approved or rejected.
router.post('/:id/departments/:name/respond', respondToInvitation);
router.post('/:id/departments/:name/resend', resendInvitation);
// A project's estimated cost: changed by whoever runs the project, decided by the finance head.
router.put('/:id/cost', updateCost);
// ... or raised to a new total, with a reason (the plan wizard asks for this before it makes many priced tasks)
router.post('/:id/cost/raise', raiseProjectCost);
router.get('/:id/spend', getProjectSpend);
// More people for a project (HR answers) and who is on it
router.post('/:id/manpower', createManpowerRequest);
router.get('/:id/team', getProjectTeam);
// who is on it: the manager and the team members ("Edit team")
router.put('/:id/team', updateProjectTeam);
router.post('/:id/cost/decision', decideCost);
router.post('/:id/approve', approveProject);
router.post('/:id/reject', rejectProject);

export default router;
