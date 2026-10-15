import express from 'express';
import { getMine, getRequests, applyTravel, cancelTravel } from '../controllers/travelController.js';
import { protect, attachRolePermissions } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect, attachRolePermissions);

router.get('/mine', getMine);
router.get('/requests', getRequests);
router.post('/', applyTravel);
router.post('/:id/cancel', cancelTravel);

export default router;
