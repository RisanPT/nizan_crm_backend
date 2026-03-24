import express from 'express';
import { createUser, getMe, getUsers, login, updateUser } from '../controllers/authController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.post('/login', login);
router.get('/me', protect, getMe);
router.get('/users', protect, getUsers);
router.post('/users', protect, createUser);
router.put('/users/:id', protect, updateUser);

export default router;
