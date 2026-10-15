import mongoose from 'mongoose';
import BankAccount from '../models/BankAccount.js';

// Fields every money-moving record carries once Accounts approves it through
// the "where did the money go" popup. Spread into a schema definition.
export const moneyAccountFields = {
  // The Bank & Cash account (Bank Balance screen) the money moved through.
  moneyAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount', default: null },
  // That account's ledger at approval time — what the posting engine uses.
  ledgerAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
  // UTR / UPI ref / cheque no., when Accounts enters one.
  paymentRef: { type: String, default: '', trim: true },
};

// Apply the popup's choice to [doc] before it is saved.
// body: { moneyAccountId, paymentMode?, paymentRef? }
// [modeField] is the record's payment-mode field and [modes] its allowed
// values; a mode outside that list is ignored rather than failing validation.
// Returns an error message, or null when applied (or nothing was sent).
export const applyMoneyAccount = async (doc, body, { modeField = null, modes = [] } = {}) => {
  const mode = String(body?.paymentMode || '');
  const setMode = () => {
    if (modeField && mode && modes.includes(mode)) doc[modeField] = mode;
  };
  const id = body?.moneyAccountId;
  if (!id) {
    // No account chosen (older clients, or nothing linked yet): keep the
    // existing cash / bank rule, but still record the mode if one was picked.
    setMode();
    return null;
  }
  if (!mongoose.Types.ObjectId.isValid(String(id))) return 'Invalid account';
  const account = await BankAccount.findById(id).select('name active ledger').lean();
  if (!account || account.active === false) return 'That bank / cash account was not found';
  if (!account.ledger) {
    return `"${account.name}" is not linked to a ledger yet — link it on the Bank & Cash Balance screen first`;
  }
  doc.moneyAccount = account._id;
  doc.ledgerAccount = account.ledger;
  if (body.paymentRef !== undefined) doc.paymentRef = String(body.paymentRef || '').trim();
  setMode();
  return null;
};
