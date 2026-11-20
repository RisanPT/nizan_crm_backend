import express from 'express';
import asyncHandler from 'express-async-handler';
import { protect } from '../middleware/authMiddleware.js';
import { attachMarketingAccess } from '../controllers/marketingEodController.js';
import { canManageMarketing } from '../controllers/contentController.js';
import {
  getSetup, getOverview, listRequests, createRequest, updateRequest, moveRequest, deleteRequest, getInterDepartment,
  listApprovals, getReviewQueue, createApproval, updateApproval, deleteApproval, decideApproval,
  listMeetings, getMeeting, createMeeting, updateMeeting, deleteMeeting, actionItemToFollowUp,
  listFollowUps, getFollowUpCalendar, createFollowUp, updateFollowUp, deleteFollowUp, getExport,
} from '../controllers/marketingCoordinationsController.js';

// /api/marketing/coordinations — Coordinations (Overview, Requests & Tasks, Inter-Department, Approvals, Meetings, Follow-ups).
// Marketing roles only (the same gate as /api/content); the CEO / Executive Director read it through the leadership guard.
// Every read takes ?from=&to=&brand=&dept= (the shared date range, brand and the Departments pill). Writes: members change what they raised or
// were given; a Marketing Manager / admin changes anything and is the only one who decides an approval.
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
router.get('/interdepartment', getInterDepartment);
router.get('/export/:type', getExport);

router.route('/requests').get(listRequests).post(createRequest);
router.post('/requests/:id/move', moveRequest);
router.route('/requests/:id').put(updateRequest).delete(deleteRequest);

router.route('/approvals').get(listApprovals).post(createApproval);
router.get('/review-queue', getReviewQueue);
router.post('/approvals/:id/decide', decideApproval);
router.route('/approvals/:id').put(updateApproval).delete(deleteApproval);

router.route('/meetings').get(listMeetings).post(createMeeting);
router.post('/meetings/:id/action-items/:itemId/follow-up', actionItemToFollowUp);
router.route('/meetings/:id').get(getMeeting).put(updateMeeting).delete(deleteMeeting);

router.route('/followups').get(listFollowUps).post(createFollowUp);
router.get('/followups/calendar', getFollowUpCalendar);
router.route('/followups/:id').put(updateFollowUp).delete(deleteFollowUp);

export default router;
