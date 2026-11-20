import express from 'express';
import asyncHandler from 'express-async-handler';
import { protect } from '../middleware/authMiddleware.js';
import { attachMarketingAccess } from '../controllers/marketingEodController.js';
import { canManageMarketing } from '../controllers/contentController.js';
import { getOverview, getLeads, getLead, getStages, getSources, getFollowUps, getConversion, getReport, getSpeed, getSpeedSettings, saveSpeedSettings } from '../controllers/marketingLeadReportController.js';

// /api/marketing/lead-report — the Lead Report (Overview, All Leads, Lead Stages, Sources, Follow-ups, Conversion, Reports).
// Marketing roles only (the same gate as /api/content); the CEO / Executive Director read it through the leadership guard.
// READ-ONLY over the leads (the CRM's own); the one thing written is the speed-to-lead settings. Every endpoint takes ?from=&to=&brand=.
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

router.get('/overview', getOverview);
router.get('/leads', getLeads);
router.get('/leads/:id', getLead);
router.get('/stages', getStages);
router.get('/sources', getSources);
router.get('/followups', getFollowUps);
router.get('/conversion', getConversion);
// speed to lead: time to a first contact; its settings (a manager changes them)
router.get('/speed', getSpeed);
router.route('/speed/settings').get(getSpeedSettings).put(saveSpeedSettings);
router.get('/reports/:type', getReport);

export default router;
