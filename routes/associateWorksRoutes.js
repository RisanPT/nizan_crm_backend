import express from 'express';
import { getAssociateWorks } from '../controllers/associateController.js';
import { convertTempStaff, getTempStaff } from '../controllers/tempStaffController.js';
import { protect, attachRolePermissions } from '../middleware/authMiddleware.js';

// /api/associate-works — the Associate Works report (who sees what is decided in the controller).
const router = express.Router();

router.use(protect, attachRolePermissions);
router.get('/', getAssociateWorks);
// the one-time conversion of the old free-text temporary-staff box (controllers/tempStaffController.js)
router.get('/temp-staff', getTempStaff);
router.post('/temp-staff/convert', convertTempStaff);

export default router;
