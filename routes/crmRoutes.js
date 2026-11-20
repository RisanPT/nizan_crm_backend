import express from 'express';
import { protect, attachRolePermissions } from '../middleware/authMiddleware.js';
import {
  addCaseActivity,
  assignWork,
  createCase,
  createReEngagementCases,
  crmGuard,
  getCase,
  getMe,
  getOverview,
  getReport,
  getQueue,
  getReEngagementList,
  getSettings,
  getTeam,
  listCases,
  updateCase,
  updateSettings,
} from '../controllers/crmController.js';
import { addEmergency, careList, getCare, photosDay, setMedical, verifyDay } from '../controllers/crmCareController.js';
import { getWeekly, listWeekly, reopenWeekly, saveWeekly, submitWeekly, weeklyFile } from '../controllers/crmWeeklyController.js';

// The CRM team's work: /api/crm. Who may do what is decided per route in controllers/crmController.js (the CRM Head and management
// see and assign everything, a member their own work; leadership only reads).
const router = express.Router();

// A booking's care is read by its own artists too (the client's medical notes, before the work) — so this one route is before the
// CRM-only guard; the controller decides who may read it.
router.get('/care/:bookingId', protect, attachRolePermissions, getCare);

router.use(protect, attachRolePermissions, crmGuard);

router.get('/me', getMe);
router.get('/overview', getOverview);
router.get('/report', getReport);
router.get('/team', getTeam);
router.get('/queue', getQueue);
router.post('/assign', assignWork);

router.get('/cases', listCases);
router.post('/cases', createCase);
router.get('/cases/:id', getCase);
router.patch('/cases/:id', updateCase);
router.post('/cases/:id/activities', addCaseActivity);

router.get('/re-engagement', getReEngagementList);
router.post('/re-engagement/cases', createReEngagementCases);

// a booking's care: "verified with the client", "photos collected", medical conditions, emergencies — and the to-do lists
router.put('/care/:bookingId/verify', verifyDay);
router.put('/care/:bookingId/photos', photosDay);
router.put('/care/:bookingId/medical', setMedical);
router.post('/care/:bookingId/emergencies', addEmergency);
router.get('/care-list', careList);

// the CRM weekly report
router.get('/weekly', getWeekly);
router.get('/weekly/list', listWeekly);
router.get('/weekly/file', weeklyFile);
router.put('/weekly', saveWeekly);
router.post('/weekly/submit', submitWeekly);
router.post('/weekly/reopen', reopenWeekly);

router.get('/settings', getSettings);
router.put('/settings', updateSettings);

export default router;
