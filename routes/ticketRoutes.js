import express from 'express';
import {
  createTicket, getTickets, getTicketStats, getTicketById, updateTicket, addComment, promoteToTask,
} from '../controllers/ticketController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();
router.use(protect);

router.route('/').get(getTickets).post(createTicket);
router.get('/stats', getTicketStats); // before /:id so 'stats' isn't read as an id
router.route('/:id').get(getTicketById).put(updateTicket);
router.post('/:id/comments', addComment);
router.post('/:id/promote', promoteToTask);

export default router;
