import express from 'express';
import {
  getBands,
  createBand,
  updateBand,
  deleteBand,
  getRevisions,
  proposeRevision,
  cancelRevision,
} from '../controllers/compensationController.js';
import { protect, attachRolePermissions } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect, attachRolePermissions);

router.route('/bands').get(getBands).post(createBand);
router.route('/bands/:id').put(updateBand).delete(deleteBand);

router.get('/revisions', getRevisions);
router.post('/revisions', proposeRevision);
router.post('/revisions/:id/cancel', cancelRevision);

export default router;
