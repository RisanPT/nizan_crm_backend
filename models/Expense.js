import mongoose from 'mongoose';

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
    amount: {
      type: Number,
      required: [true, 'Please add an amount'],
      min: 0,
    },
    date: {
      type: Date,
      required: true,
      default: Date.now,
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
  },
  {
    timestamps: true,
  }
);

const Expense = mongoose.model('Expense', expenseSchema);

export default Expense;
