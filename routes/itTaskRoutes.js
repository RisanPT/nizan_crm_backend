import express from 'express';
import { getITTasks, createITTask, updateITTask, deleteITTask, bulkUpdateTasks } from '../controllers/itTaskController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);
router.post('/bulk-update', bulkUpdateTasks);
router.route('/').get(getITTasks).post(createITTask);
router.route('/:id').put(updateITTask).delete(deleteITTask);

export default router;
