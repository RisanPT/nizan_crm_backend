import mongoose from 'mongoose';
import { moneyAccountFields } from '../utils/moneyAccount.js';

const expenseSchema = mongoose.Schema(
  {
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      required: [true, 'Please specify the employee'],
    },
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Booking',
      default: null,
    },
    category: {
      type: String,
      enum: ['food', 'travel', 'stay', 'materials', 'fuel', 'other'],
      default: 'other',
    },
    // What the spend was FOR — kept separate from `category` (which is the
    // kind of spend) so bridal client work and internal model shoots can be
    // reported and budgeted independently.
    workType: {
      type: String,
      enum: ['bridal', 'model_shoot'],
      default: 'bridal',
    },
    // For FOOD: which meal it was. With the time in `date`, this lets Accounts put the
    // spend under the work it was eaten for (utils/mealAllocation.js). '' = not recorded
    // (older entries, or non-food).
    meal: {
      type: String,
      enum: ['', 'breakfast', 'lunch', 'snacks', 'dinner'],
      default: '',
    },
    // For FOOD: every meal the entry covers. One bill may cover several (a long trip: breakfast,
    // lunch and dinner together); then `meal` is '' and this holds them. Older entries have only
    // `meal` — read both through mealsOf() in utils/mealAllocation.js.
    meals: {
      type: [{ type: String, enum: ['breakfast', 'lunch', 'snacks', 'dinner'] }],
      default: [],
    },
    // What counts: while pending, what the artist logged; once Accounts approves it, the APPROVED
    // amount (which may be less — see utils/expenseApproval.js). The books, the Bank & Cash
    // balance and every report read this one.
    amount: {
      type: Number,
      required: [true, 'Please add an amount'],
      min: 0,
    },
    // What the artist originally logged — kept ONLY when the approval reduced the amount; null otherwise.
    loggedAmount: { type: Number, default: null, min: 0 },
    // Why it was approved for less (optional; shown to the artist).
    approvalNote: { type: String, default: '', trim: true },
    date: {
      type: Date,
      required: true,
      default: Date.now,
    },
    // When the work this bill belongs to took place. Bridal bills take it
    // from the linked booking (bookingId); model-shoot bills store it here.
    eventDate: {
      type: Date,
      default: null,
    },
    notes: {
      type: String,
      default: '',
      trim: true,
    },
    receiptImage: {
      type: String,
      default: '',
    },
    status: {
      type: String,
      enum: ['pending', 'verified', 'rejected'],
      default: 'pending',
    },
    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    verifiedAt: {
      type: Date,
      default: null,
    },
    ocrAmountFound: {
      type: Number,
      default: null,
    },
    ocrStatus: {
      type: String,
      enum: ['match', 'mismatch', 'skipped', 'pending'],
      default: 'pending',
    },
    ocrRawText: {
      type: String,
      default: '',
    },
    // How it was paid back + the bank / cash account, set when Accounts
    // verifies it. Only expenses verified this way post to the ledger.
    paymentMode: { type: String, default: '', trim: true },
    ...moneyAccountFields,
  },
  {
    timestamps: true,
  }
);

// the Accounts lists: newest first, narrowed by status / artist / month
expenseSchema.index({ date: -1 });
expenseSchema.index({ status: 1, date: -1 });
expenseSchema.index({ employeeId: 1, date: -1 });

const Expense = mongoose.model('Expense', expenseSchema);

export default Expense;
