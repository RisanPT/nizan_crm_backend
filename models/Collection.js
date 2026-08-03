import mongoose from 'mongoose';

const collectionSchema = mongoose.Schema(
  {
    // A collection attaches to EITHER a booking OR a trial (validated in the
    // controller). Both are optional at the schema level so trial payments can
    // be recorded without a booking.
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Booking',
      default: null,
    },
    trialId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Trial',
      default: null,
    },
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      required: [true, 'Please specify the artist'],
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
    paymentMode: {
      type: String,
      enum: ['cash', 'upi', 'bank_transfer', 'other'],
      default: 'cash',
    },
    notes: {
      type: String,
      default: '',
      trim: true,
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
    attachmentUrl: {
      type: String,
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

const Collection = mongoose.model('Collection', collectionSchema);

export default Collection;
