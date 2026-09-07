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
  getScoringConfig,
  updateScoringConfig,
  getScoreTrend,
} from '../controllers/marketingController.js';
import {
  getMarketingInsights,
  getReEngagement,
} from '../controllers/marketingInsightsController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);

// Marketing Intelligence — customer NPS/CSAT, utilization, FY slot utilization,
// segment breakdowns, and the re-engagement worklist.
router.get('/insights', getMarketingInsights);
router.get('/re-engagement', getReEngagement);

router.route('/competitors').get(getCompetitors).post(createCompetitor);
router.post('/competitors/import', importCompetitors);
router.route('/competitors/:id').put(updateCompetitor).delete(deleteCompetitor);
router.post('/competitors/:id/snapshot', upsertSnapshot);

router.get('/snapshots', getSnapshots);
router.get('/rankings', getRankings);
router.get('/competitors/:id/trend', getScoreTrend);
router.route('/scoring-config').get(getScoringConfig).put(updateScoringConfig);

export default router;
