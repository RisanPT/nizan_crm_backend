import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import {
  getBankAccounts,
  createBankAccount,
  updateBankAccount,
  recordBalance,
  deleteBankAccount,
  linkLedger,
  getLedgerOptions,
  getTransactions,
} from '../controllers/bankAccountController.js';

const router = express.Router();

router.use(protect);

router.route('/').get(getBankAccounts).post(createBankAccount);
router.get('/ledger-options', getLedgerOptions);
router.put('/:id/ledger', linkLedger);
router.get('/:id/transactions', getTransactions);
router.post('/:id/balance', recordBalance);
router.route('/:id').put(updateBankAccount).delete(deleteBankAccount);

export default router;
