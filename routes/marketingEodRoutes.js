import express from 'express';
import {
  getSetupData,
  saveGroup,
  saveRole,
  saveMetric,
  saveRoleProfile,
  saveTeamMember,
  getMemberMetrics,
  saveMemberMetrics,
  getTargets,
  saveTargets,
  copyTargets,
  getEodEntry,
  saveEodEntry,
  getIndividualDashboard,
  getTeamSummary,
  getMissedEods,
  saveRemarks,
  signOffMonth,
  reopenMonth,
  getWeeklyPageStats,
  saveWeeklyPageStats,
  saveSettings,
  getAuditLog,
  exportRecords,
  sendReminder,
  attachMarketingAccess,
  getMyAccess,
  getLinkableUsers,
} from '../controllers/marketingEodController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);
router.use(attachMarketingAccess);

// Setup & Master Data
router.get('/setup', getSetupData);
router.post('/groups', saveGroup);
router.post('/roles', saveRole);
router.post('/metrics', saveMetric);
router.post('/role-profiles', saveRoleProfile);
router.post('/members', saveTeamMember);
router.get('/member-metrics', getMemberMetrics);
router.post('/member-metrics', saveMemberMetrics);

// Targets
router.get('/targets', getTargets);
router.post('/targets', saveTargets);
router.post('/targets/copy', copyTargets);

// Daily EOD
router.get('/entry', getEodEntry);
router.post('/entry', saveEodEntry);

// Dashboards & Summary
router.get('/dashboard', getIndividualDashboard);
router.get('/team-summary', getTeamSummary);
router.get('/missed', getMissedEods);

// Remarks & Sign-off
router.post('/remarks', saveRemarks);
router.post('/sign-off', signOffMonth);
router.post('/reopen', reopenMonth);

// Weekly Page Stats (FR-18)
router.get('/weekly-stats', getWeeklyPageStats);
router.post('/weekly-stats', saveWeeklyPageStats);

// Settings, audit, export, reminders
router.post('/settings', saveSettings);
router.get('/audit', getAuditLog);
router.get('/export', exportRecords);
router.post('/remind', sendReminder);
router.get('/me', getMyAccess);
router.get('/users', getLinkableUsers);

export default router;
