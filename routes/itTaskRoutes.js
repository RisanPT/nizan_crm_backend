import express from 'express';
import { getITTasks, createITTask, updateITTask, deleteITTask } from '../controllers/itTaskController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);
router.route('/').get(getITTasks).post(createITTask);
router.route('/:id').put(updateITTask).delete(deleteITTask);

export default router;
