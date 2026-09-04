import express from 'express';
import {
  getReviewForm,
  submitReview,
  getReviews,
  getReviewAnalytics,
  getArtistReviewPerformance,
  getReviewById,
  updateReview,
  createReviewForBooking,
} from '../controllers/reviewController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

// Public — the client opens and submits the form (no login).
router.get('/form/:token', getReviewForm);
router.post('/submit/:token', submitReview);

// Staff — everything below requires auth.
router.use(protect);
router.get('/', getReviews);
// '/analytics' must precede '/:id' so it isn't captured as an id.
router.get('/analytics', getReviewAnalytics);
router.get('/artist/:employeeId', getArtistReviewPerformance);
router.post('/for-booking/:bookingId', createReviewForBooking);
router.get('/:id', getReviewById);
router.put('/:id', updateReview);

export default router;
