import express from 'express';
import {
  getEmployees,
  getEmployee,
  createEmployee,
  updateEmployee,
  deleteEmployee,
  getEmployeeIncrements,
  addEmployeeIncrement,
  getOrgTree,
  setReportingDetails,
  linkTimeboxAccount,
} from '../controllers/employeeController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);
router.route('/').get(getEmployees).post(createEmployee);
// Declared before '/:id' so 'org-tree' isn't captured as an :id.
router.get('/org-tree', getOrgTree);
router.route('/:id').get(getEmployee).put(updateEmployee).delete(deleteEmployee);
router.put('/:id/reporting', setReportingDetails);
router.put('/:id/timebox-link', linkTimeboxAccount);
router.route('/:id/increments').get(getEmployeeIncrements).post(addEmployeeIncrement);

export default router;
