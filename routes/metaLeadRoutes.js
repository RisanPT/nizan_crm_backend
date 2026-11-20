import express from 'express';
import asyncHandler from 'express-async-handler';
import { protect } from '../middleware/authMiddleware.js';
import { attachMarketingAccess } from '../controllers/marketingEodController.js';
import { canManageMarketing } from '../controllers/contentController.js';
import { checkMissed, getStatus, listEvents, retryEvent, testConnection, updateSettings } from '../controllers/metaLeadsController.js';
import { addAllCampaigns, addCampaign, getAdsStatus, ignoreCampaign, linkCampaign, restoreCampaign, syncNow, updateAdsSettings } from '../controllers/metaAdsController.js';
import { getCapiStatus, listCapiEvents, sendNow, updateCapiSettings } from '../controllers/metaCapiController.js';
import { addAllPosts, addPost, findAccounts, getIgStatus, igSyncNow, ignorePost, linkPost, restorePost, updateIgSettings } from '../controllers/metaIgController.js';

// /api/meta — the Meta screen (Marketing → Campaigns → Meta): Lead Ads, the live ad spend sync (/ads/*), lead results back to Meta
// (/capi/*) and Instagram insights (/ig/*). Marketing roles only; who gets a new lead, whether the sync runs on its own and whether results are sent are the Marketing
// Manager's / admin's choice (checked in the controllers). The webhook itself is routes/metaWebhookRoutes.js.
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

router.get('/status', asyncHandler(getStatus));
router.get('/events', asyncHandler(listEvents));
router.post('/test', asyncHandler(testConnection));
router.put('/settings', asyncHandler(updateSettings));
router.post('/events/:id/retry', asyncHandler(retryEvent));
router.post('/check', asyncHandler(checkMissed));

// the live ad spend sync (controllers/metaAdsController.js)
router.get('/ads/status', asyncHandler(getAdsStatus));
router.post('/ads/sync', asyncHandler(syncNow));
router.put('/ads/settings', asyncHandler(updateAdsSettings));
router.post('/ads/unlinked/add-all', asyncHandler(addAllCampaigns));
router.post('/ads/unlinked/:metaId/link', asyncHandler(linkCampaign));
router.post('/ads/unlinked/:metaId/add', asyncHandler(addCampaign));
router.post('/ads/unlinked/:metaId/ignore', asyncHandler(ignoreCampaign));
router.post('/ads/ignored/:metaId/restore', asyncHandler(restoreCampaign));

// lead results back to Meta — the Conversions API (controllers/metaCapiController.js)
router.get('/capi/status', asyncHandler(getCapiStatus));
router.put('/capi/settings', asyncHandler(updateCapiSettings));
router.post('/capi/send', asyncHandler(sendNow));
router.get('/capi/events', asyncHandler(listCapiEvents));

// Instagram insights → the Socials module (controllers/metaIgController.js)
router.get('/ig/status', asyncHandler(getIgStatus));
router.post('/ig/sync', asyncHandler(igSyncNow));
router.put('/ig/settings', asyncHandler(updateIgSettings));
router.post('/ig/find', asyncHandler(findAccounts));
router.post('/ig/unmatched/add-all', asyncHandler(addAllPosts));
router.post('/ig/unmatched/:mediaId/add', asyncHandler(addPost));
router.post('/ig/unmatched/:mediaId/link', asyncHandler(linkPost));
router.post('/ig/unmatched/:mediaId/ignore', asyncHandler(ignorePost));
router.post('/ig/ignored/:mediaId/restore', asyncHandler(restorePost));

export default router;
