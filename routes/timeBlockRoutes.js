import express from 'express';
import { getTimeBlocks, createTimeBlock, updateTimeBlock, deleteTimeBlock } from '../controllers/timeBlockController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);
router.route('/').get(getTimeBlocks).post(createTimeBlock);
router.route('/:id').put(updateTimeBlock).delete(deleteTimeBlock);

export default router;
