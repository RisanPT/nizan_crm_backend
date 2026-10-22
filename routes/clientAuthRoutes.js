import express from 'express';
import {
  requestOtp,
  verifyOtp,
  requestLink,
  linkLogin,
} from '../controllers/clientAuthController.js';

const router = express.Router();

// All public (no staff auth): this is how clients obtain a client token.
router.post('/request-otp', requestOtp);
router.post('/verify-otp', verifyOtp);
router.post('/request-link', requestLink);
router.get('/link/:token', linkLogin);

export default router;
