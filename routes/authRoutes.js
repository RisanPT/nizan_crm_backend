import express from 'express';
import {
  createUser,
  deleteUser,
  getMe,
  getUsers,
  login,
  updateUser,
  grantDriverLogin,
  provisionEmployeeLogin,
  bulkProvisionEmployees,
  renderSetPasswordPage,
  submitSetPassword,
} from '../controllers/authController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.post('/login', login);
router.get('/me', protect, getMe);
router.get('/users', protect, getUsers);
router.post('/users', protect, createUser);
router.post('/users/driver-login', protect, grantDriverLogin);
router.put('/users/:id', protect, updateUser);
router.delete('/users/:id', protect, deleteUser);

// ESS provisioning (HR-only) + the public set-password flow.
router.post('/provision-employee', protect, provisionEmployeeLogin);
router.post('/provision-employees', protect, bulkProvisionEmployees);
router.get('/set-password/:token', renderSetPasswordPage);
router.post('/set-password', submitSetPassword);

export default router;
