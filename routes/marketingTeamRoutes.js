import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import { attachMarketingAccess } from '../controllers/marketingEodController.js';
import {
  getLogSetup, createActivity, updateActivity, deleteActivity, getTeamActivity, getTeamOverview, getTimesheet, getPerformance,
  getTeamAttendance, setWorkMode, getLogs, listTasks, createTask, updateTask, deleteTask, addTaskComment, getReport,
} from '../controllers/marketingTeamController.js';

// /api/marketing/team — the Marketing Team Dashboard and the Log Activity record behind it.
const router = express.Router();
router.use(protect);
router.use(attachMarketingAccess);

router.get('/log-setup', getLogSetup);
router.post('/activities', createActivity);
router.route('/activities/:id').put(updateActivity).delete(deleteActivity);

router.get('/overview', getTeamOverview);
router.get('/activity', getTeamActivity);
router.get('/timesheet', getTimesheet);
router.get('/logs', getLogs);
router.get('/performance', getPerformance);
router.get('/attendance', getTeamAttendance);
router.put('/work-mode', setWorkMode);
router.get('/reports/:type', getReport);

router.route('/tasks').get(listTasks).post(createTask);
router.route('/tasks/:id').put(updateTask).delete(deleteTask);
router.post('/tasks/:id/comments', addTaskComment);

export default router;
