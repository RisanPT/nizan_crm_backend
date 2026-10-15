import mongoose from 'mongoose';

// Singleton accounting configuration. `lockDate` closes the books: no voucher
// may be posted, edited or voided with a date on or before it. null = open.
const accountingSettingSchema = mongoose.Schema(
  {
    lockDate: { type: Date, default: null },
    lockedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    lockedAt: { type: Date, default: null },
    // Bank & Cash account that booking advances land in. Sales confirm the
    // advance before converting, so when this is set a new advance posts here
    // straight away; null = advances wait for Accounts to verify.
    advanceMoneyAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount', default: null },
  },
  { timestamps: true }
);

const AccountingSetting = mongoose.model('AccountingSetting', accountingSettingSchema);

export default AccountingSetting;
