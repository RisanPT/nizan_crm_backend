import express from 'express';
import { getITTasks, createITTask, updateITTask, deleteITTask, bulkUpdateTasks, extendITTask } from '../controllers/itTaskController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);
router.post('/bulk-update', bulkUpdateTasks);
// extend a task's due date: a new day and a reason, written down for good
router.post('/:id/extend', extendITTask);
router.route('/').get(getITTasks).post(createITTask);
router.route('/:id').put(updateITTask).delete(deleteITTask);

export default router;
