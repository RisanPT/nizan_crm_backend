import express from 'express';
import { createUser, deleteUser, getMe, getUsers, login, updateUser, grantDriverLogin } from '../controllers/authController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.post('/login', login);
router.get('/me', protect, getMe);
router.get('/users', protect, getUsers);
router.post('/users', protect, createUser);
router.post('/users/driver-login', protect, grantDriverLogin);
router.put('/users/:id', protect, updateUser);
router.delete('/users/:id', protect, deleteUser);

export default router;
