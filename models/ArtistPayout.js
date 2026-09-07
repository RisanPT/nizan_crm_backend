import mongoose from 'mongoose';

// A per-booking fee owed to an OUTSOURCE (freelance) artist for a job they
// worked. This is the freelancer's compensation path — they are NOT on monthly
// payroll. Lifecycle: pending → approved → paid. Paying it posts a Payment
// voucher to the ledger against the Artist Payouts head (COGS) — see
// services/posting.js (ArtistPayout builder).
const artistPayoutSchema = mongoose.Schema(
  {
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      required: [true, 'Please specify the artist'],
    },
    // Denormalized for the ledger narration and list display (the Employee may
    // be renamed later; the voucher keeps the name at time of payout).
    employeeName: {
      type: String,
      default: '',
      trim: true,
    },
    // The booking this fee is for. Optional so an ad-hoc/advance payout can be
    // recorded, but normally set.
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Booking',
      default: null,
    },
    bookingNumber: {
      type: String,
      default: '',
      trim: true,
    },
    amount: {
      type: Number,
      required: [true, 'Please add an amount'],
      min: 0,
    },
    // The work / payout date (drives the ledger voucher date once paid).
    date: {
      type: Date,
      required: true,
      default: Date.now,
    },
    paymentMode: {
      type: String,
      enum: ['cash', 'upi', 'bank_transfer', 'other'],
      default: 'bank_transfer',
    },
    notes: {
      type: String,
      default: '',
      trim: true,
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'paid', 'cancelled'],
      default: 'pending',
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    approvedAt: {
      type: Date,
      default: null,
    },
    paidBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    paidAt: {
      type: Date,
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

const ArtistPayout = mongoose.model('ArtistPayout', artistPayoutSchema);

export default ArtistPayout;
