import express from 'express';
import { protect, attachRolePermissions } from '../middleware/authMiddleware.js';
import {
  getCashTransactions,
  getTransactionAccounts,
  createCashTransaction,
  updateCashTransaction,
  deleteCashTransaction,
} from '../controllers/cashTransactionController.js';

const router = express.Router();

router.use(protect);
router.use(attachRolePermissions);

router.get('/accounts', getTransactionAccounts);
router.route('/').get(getCashTransactions).post(createCashTransaction);
router.route('/:id').put(updateCashTransaction).delete(deleteCashTransaction);

export default router;
