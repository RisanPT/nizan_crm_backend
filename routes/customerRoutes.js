import express from 'express';
import { getCustomers, createCustomer, updateCustomer, deleteCustomer } from '../controllers/customerController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);
router.route('/').get(getCustomers).post(createCustomer);
router.route('/:id').put(updateCustomer).delete(deleteCustomer);

export default router;
