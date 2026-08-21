import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import {
  getBankAccounts,
  createBankAccount,
  updateBankAccount,
  recordBalance,
  deleteBankAccount,
} from '../controllers/bankAccountController.js';

const router = express.Router();

router.use(protect);

router.route('/').get(getBankAccounts).post(createBankAccount);
router.post('/:id/balance', recordBalance);
router.route('/:id').put(updateBankAccount).delete(deleteBankAccount);

export default router;
