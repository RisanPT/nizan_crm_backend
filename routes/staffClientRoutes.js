import express from 'express';
import { protect, attachRolePermissions } from '../middleware/authMiddleware.js';
import {
  listAppClients,
  getAppClient,
  canSeeAppClients,
} from '../controllers/staffClientController.js';

const router = express.Router();

const guard = (req, res, next) => {
  if (!canSeeAppClients(req.user)) {
    return res.status(403).json({ message: 'Not allowed' });
  }
  next();
};

router.get('/', protect, attachRolePermissions, guard, listAppClients);
router.get('/:id', protect, attachRolePermissions, guard, getAppClient);

export default router;
