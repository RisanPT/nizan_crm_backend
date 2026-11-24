import express from 'express';
import asyncHandler from 'express-async-handler';
import { protect } from '../middleware/authMiddleware.js';
import { mayViewAllocation } from '../utils/allocationAccess.js';
import { createTeam, deactivateTeam, listCandidates, listTeams, reorderTeams, updateTeam } from '../controllers/artistTeamController.js';

// /api/artist-teams — the CRM's Artist Management (controllers/artistTeamController.js). Changes: utils/allocationAccess.js mayManageTeams.
const router = express.Router();
router.use(protect);
router.use(
  asyncHandler(async (req, res, next) => {
    if (mayViewAllocation(req.user)) return next();
    res.status(403);
    throw new Error('Artist Management is for the CRM team, the Artist Head and managers.');
  }),
);
router.route('/').get(listTeams).post(createTeam);
router.get('/candidates', listCandidates);
router.put('/order', reorderTeams);
router.route('/:id').put(updateTeam).delete(deactivateTeam);
export default router;
