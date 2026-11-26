import express from 'express';
import asyncHandler from 'express-async-handler';
import { protect } from '../middleware/authMiddleware.js';
import { attachMarketingAccess } from '../controllers/marketingEodController.js';
import { canEnterCreative } from '../controllers/contentController.js';
import {
  getOverview, getCalendar, listAssets, getAsset, createAsset, updateAsset, deleteAsset, listAccounts, createAccount, updateAccount, deleteAccount,
  getPublishing, getTargets, setTargets, getPerformance, getReports, listAssetKeywords, renameAssetKeyword, removeAssetKeyword, bulkAssetKeywords,
} from '../controllers/marketingSocialsController.js';

// /api/marketing/socials — the Socials module (Overview, Calendar, Content & Assets, Publishing & Accounts, Performance, Reports).
// Marketing roles only (the same gate as /api/content); the CEO / Executive Director read it through the leadership guard.
const router = express.Router();
router.use(protect);
router.use(attachMarketingAccess);
router.use(
  asyncHandler(async (req, res, next) => {
    if (await canEnterCreative(req.user)) return next(); // Marketing, or the Creative Director
    res.status(403);
    throw new Error('Only the Marketing team can open Socials.');
  }),
);

router.get('/overview', getOverview);
router.get('/calendar', getCalendar);
router.get('/publishing', getPublishing);
router.get('/performance', getPerformance);
router.get('/reports', getReports);
router.route('/targets').get(getTargets).put(setTargets);
router.route('/assets').get(listAssets).post(createAsset);
// the gallery's keywords (before /assets/:id, which would read "keywords" as an id)
router.get('/assets/keywords', listAssetKeywords);
router.post('/assets/keywords/rename', renameAssetKeyword);
router.post('/assets/keywords/remove', removeAssetKeyword);
router.post('/assets/bulk-keywords', bulkAssetKeywords);
router.route('/assets/:id').get(getAsset).put(updateAsset).delete(deleteAsset);
router.route('/accounts').get(listAccounts).post(createAccount);
router.route('/accounts/:id').put(updateAccount).delete(deleteAccount);

export default router;
