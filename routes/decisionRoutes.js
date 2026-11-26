import express from 'express';
import { protect, attachRolePermissions } from '../middleware/authMiddleware.js';
import { getQueue, getByRef, getRequest, decide, getDecisionPolicy, updateDecisionPolicy } from '../controllers/decisionController.js';

// /api/decisions — the CEO / Executive Director's desk
const router = express.Router();
router.use(protect);
router.get('/queue', getQueue);
router.get('/by-ref', getByRef);
router.get('/:id', getRequest);
router.post('/:id/decide', decide);

// /api/decision-policy — what is escalated to them (mounted separately, see server.js)
export const policyRouter = express.Router();
policyRouter.use(protect, attachRolePermissions);
policyRouter.route('/').get(getDecisionPolicy).put(updateDecisionPolicy);

export default router;
