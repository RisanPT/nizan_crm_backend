import express from 'express';
import { consultationGuard } from '../controllers/consultationController.js';
import {
  createClient,
  downloadClientReport,
  getClient,
  listClients,
  refreshClient,
  searchTeamN,
  updateClient,
} from '../controllers/stylistClientController.js';
import { attachRolePermissions, protect } from '../middleware/authMiddleware.js';

// Stylist client files. Same access as consultations: any consultations
// permission; stylists see their own clients, stylist leads see all.
const router = express.Router();

router.use(protect, attachRolePermissions, consultationGuard);

router.route('/').get(listClients).post(createClient);
// Fixed paths before '/:id'.
router.get('/team-n-search', searchTeamN);
router.route('/:id').get(getClient).put(updateClient);
router.post('/:id/refresh', refreshClient);
router.get('/:id/report', downloadClientReport);

export default router;
