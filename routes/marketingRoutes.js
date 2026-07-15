import express from 'express';
import {
  getCompetitors,
  createCompetitor,
  updateCompetitor,
  deleteCompetitor,
  upsertSnapshot,
  getSnapshots,
  importCompetitors,
  getRankings,
} from '../controllers/marketingController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);

router.route('/competitors').get(getCompetitors).post(createCompetitor);
router.post('/competitors/import', importCompetitors);
router.route('/competitors/:id').put(updateCompetitor).delete(deleteCompetitor);
router.post('/competitors/:id/snapshot', upsertSnapshot);

router.get('/snapshots', getSnapshots);
router.get('/rankings', getRankings);

export default router;
