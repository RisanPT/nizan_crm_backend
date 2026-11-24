import express from 'express';
import { getCeoInbox, getCeoSignals } from '../controllers/ceoController.js';
import {
  getDecisions,
  createDecision,
  updateDecision,
  deleteDecision,
} from '../controllers/ceoDecisionController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);
router.get('/inbox', getCeoInbox);
router.get('/signals', getCeoSignals);

// CEO decisions endpoints mirror
router.route('/decisions')
  .get(getDecisions)
  .post(createDecision);

router.route('/decisions/:id')
  .put(updateDecision)
  .patch(updateDecision)
  .delete(deleteDecision);

export default router;
