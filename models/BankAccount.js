import mongoose from 'mongoose';

// A manually-maintained bank balance. The team enters the current balance they
// see in the bank (this app does not auto-sync with banks), keeping a history
// of every manual update for an audit trail.
const balanceEntrySchema = mongoose.Schema(
  {
    balance: { type: Number, required: true },
    asOf: { type: Date, required: true },
    note: { type: String, default: '' },
    byId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    byName: { type: String, default: '' },
  },
  { timestamps: true },
);

const bankAccountSchema = mongoose.Schema(
  {
    name: { type: String, required: true, trim: true }, // label, e.g. "HDFC Current"
    bankName: { type: String, default: '', trim: true },
    accountNumber: { type: String, default: '', trim: true },
    // The latest manually-entered balance and the date it is as of.
    balance: { type: Number, default: 0 },
    asOf: { type: Date, default: null },
    note: { type: String, default: '' },
    active: { type: Boolean, default: true },
    history: { type: [balanceEntrySchema], default: [] },
  },
  { timestamps: true },
);

const BankAccount = mongoose.model('BankAccount', bankAccountSchema);

export default BankAccount;
