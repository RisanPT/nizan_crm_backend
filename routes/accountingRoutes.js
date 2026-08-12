import express from 'express';
import {
  seedAccounts,
  getAccounts,
  createAccount,
  updateAccount,
  deleteAccount,
  getJournalEntries,
  createJournalEntry,
  voidJournalEntry,
  getTrialBalance,
  getProfitAndLoss,
  getBalanceSheet,
  getReceivables,
  getPayables,
  getPartyStatement,
  getAccountLedger,
  getAccountingSettings,
  updateAccountingSettings,
  getGstSettings,
  updateGstSettings,
  getGstSummary,
  getGstr1,
  backfillLedger,
} from '../controllers/accountingController.js';
import {
  getBankAccounts,
  importStatement,
  getReconciliation,
  autoMatch,
  matchManual,
  unmatch,
  clearStatement,
} from '../controllers/bankReconController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);

// Chart of Accounts
router.post('/accounts/seed', seedAccounts);
router.route('/accounts').get(getAccounts).post(createAccount);
router.route('/accounts/:id').put(updateAccount).delete(deleteAccount);

// Journal
router.route('/journal').get(getJournalEntries).post(createJournalEntry);
router.delete('/journal/:id', voidJournalEntry);

// Reports
router.get('/trial-balance', getTrialBalance);
router.get('/profit-loss', getProfitAndLoss);
router.get('/balance-sheet', getBalanceSheet);
router.get('/receivables', getReceivables);
router.get('/payables', getPayables);
router.get('/party-statement', getPartyStatement);
router.get('/ledger/:accountId', getAccountLedger);
router.route('/settings').get(getAccountingSettings).put(updateAccountingSettings);

// GST
router.route('/gst/settings').get(getGstSettings).put(updateGstSettings);
router.get('/gst/summary', getGstSummary);
router.get('/gst/gstr1', getGstr1);

// Bank reconciliation
router.get('/bank/accounts', getBankAccounts);
router.post('/bank/import', importStatement);
router.get('/bank/reconciliation', getReconciliation);
router.post('/bank/auto-match', autoMatch);
router.post('/bank/match', matchManual);
router.post('/bank/unmatch', unmatch);
router.delete('/bank/statement', clearStatement);

// Post operational documents into the ledger (idempotent).
router.post('/backfill', backfillLedger);

export default router;
