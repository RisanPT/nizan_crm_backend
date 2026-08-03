/**
 * SalesReturn — SRT-01 Credit Note
 *
 * Records refunds / credit notes issued to brides (customers).
 * Per the ERP Expense Heads document (§ 4, §5):
 *   - Must NOT be posted as a plain expense ledger.
 *   - Must reduce revenue rather than add to expenses.
 *   - Bride name captured in a mandatory separate narration field.
 *   - Linked to the original booking / invoice.
 */

import mongoose from 'mongoose';

export const SALES_RETURN_STATUSES = ['draft', 'approved', 'processed', 'cancelled'];
export const SALES_RETURN_PAYMENT_MODES = [
  'cash',
  'upi',
  'bank_transfer',
  'cheque',
  'other',
];

const salesReturnSchema = mongoose.Schema(
  {
    // Credit note reference number (e.g. CN-2026-001)
    creditNoteNumber: {
      type: String,
      required: [true, 'Please provide a credit note number'],
      trim: true,
      unique: true,
    },

    // The booking this refund relates to
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Booking',
      default: null,
    },

    // Original invoice reference for traceability
    originalInvoiceRef: {
      type: String,
      default: '',
      trim: true,
    },

    // Customer / Bride details — mandatory per document §5
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      default: null,
    },
    brideName: {
      type: String,
      required: [true, 'Bride name is mandatory for a sales return'],
      trim: true,
    },

    // Refund amount
    amount: {
      type: Number,
      required: [true, 'Please specify the refund amount'],
      min: [0, 'Amount cannot be negative'],
    },

    date: {
      type: Date,
      required: true,
      default: Date.now,
    },

    // Reason for the refund — mandatory narration per the document
    reason: {
      type: String,
      required: [true, 'Please provide a reason / narration for the return'],
      trim: true,
    },

    paymentMode: {
      type: String,
      enum: SALES_RETURN_PAYMENT_MODES,
      default: 'bank_transfer',
    },

    status: {
      type: String,
      enum: SALES_RETURN_STATUSES,
      default: 'draft',
    },

    // Document evidence
    attachmentUrl: {
      type: String,
      default: '',
    },

    // Approval trail
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    approvedAt: {
      type: Date,
      default: null,
    },

    processedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    processedAt: {
      type: Date,
      default: null,
    },

    notes: {
      type: String,
      default: '',
      trim: true,
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

salesReturnSchema.index({ bookingId: 1 });
salesReturnSchema.index({ status: 1 });
salesReturnSchema.index({ date: -1 });

const SalesReturn = mongoose.model('SalesReturn', salesReturnSchema);

export default SalesReturn;
