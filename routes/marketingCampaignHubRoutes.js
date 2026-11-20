import express from 'express';
import asyncHandler from 'express-async-handler';
import { protect } from '../middleware/authMiddleware.js';
import { attachMarketingAccess } from '../controllers/marketingEodController.js';
import { canManageMarketing } from '../controllers/contentController.js';
import {
  getSetup,
  getOverview,
  listCampaigns,
  getCampaign,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  getPerformance,
  listAds,
  createAd,
  updateAd,
  deleteAd,
  getBudget,
  getAudiences,
  getLeads,
  getReports,
  getReport,
  saveMetric,
  deleteMetric,
  importMetrics,
  listImports,
} from '../controllers/marketingCampaignHubController.js';

// /api/marketing/campaign-hub — the Campaigns hub (Overview, All Campaigns, Performance, Creatives & Ads, Budget & Spend, Leads & Conversions, Reports & Insights;
// /audiences = the audience & placement breakdowns imported from Ads Manager).
// Marketing roles only (the same gate as /api/content); the CEO / Executive Director read it through the leadership guard.
// Anyone on the team can add and change campaigns, ads and a day's figures, and import a Meta Ads Manager export; deleting a campaign is a
// Marketing Manager's call. (The older /api/marketing/campaigns* endpoints are separate and unchanged.)
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

router.get('/setup', getSetup);
router.get('/overview', getOverview);
router.route('/campaigns').get(listCampaigns).post(createCampaign);
router.route('/campaigns/:id').get(getCampaign).put(updateCampaign).delete(deleteCampaign);
router.get('/performance', getPerformance);
router.route('/ads').get(listAds).post(createAd);
router.route('/ads/:id').put(updateAd).delete(deleteAd);
router.get('/budget', getBudget);
router.get('/audiences', getAudiences);
router.get('/leads', getLeads);
router.get('/reports', getReports);
router.get('/reports/:type', getReport);
router.post('/metrics', saveMetric);
router.delete('/metrics/:id', deleteMetric);
router.post('/import', importMetrics);
router.get('/imports', listImports);

export default router;
