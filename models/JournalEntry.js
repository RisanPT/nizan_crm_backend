import mongoose from 'mongoose';

// Voucher types mirror the classic day-book vouchers. Phase 0 creates them by
// hand (mostly 'journal'); later phases post the rest automatically.
export const VOUCHER_TYPES = [
  'journal',
  'sales',
  'purchase',
  'receipt',
  'payment',
  'contra',
  'credit_note',
  'debit_note',
];

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const journalLineSchema = mongoose.Schema(
  {
    account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ChartOfAccount',
      required: true,
    },
    debit: { type: Number, default: 0, min: 0 },
    credit: { type: Number, default: 0, min: 0 },
    narration: { type: String, default: '', trim: true },
  },
  { _id: false }
);

const journalEntrySchema = mongoose.Schema(
  {
    date: { type: Date, required: true },
    voucherNo: { type: String, default: '', trim: true },
    voucherType: { type: String, enum: VOUCHER_TYPES, default: 'journal' },
    narration: { type: String, default: '', trim: true },
    lines: { type: [journalLineSchema], default: [] },
    // Back-link to the source document that produced this entry (null for a
    // hand-keyed voucher). Lets the posting layer stay idempotent later.
    source: {
      model: { type: String, default: '' },
      id: { type: mongoose.Schema.Types.ObjectId, default: null },
    },
    status: { type: String, enum: ['draft', 'posted', 'void'], default: 'posted' },
    fyLabel: { type: String, default: '' }, // e.g. '2026-27'
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    postedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// The one rule that makes this "accounting": every posted entry must balance,
// have ≥2 lines, and no line may be both debit and credit.
journalEntrySchema.pre('validate', function (next) {
  if (this.status === 'void') return next();
  const lines = this.lines || [];
  if (lines.length < 2) {
    return next(new Error('A journal entry needs at least two lines.'));
  }
  let dr = 0;
  let cr = 0;
  for (const l of lines) {
    const d = round2(l.debit);
    const c = round2(l.credit);
    if (d > 0 && c > 0) {
      return next(new Error('A line cannot be both debit and credit.'));
    }
    if (d <= 0 && c <= 0) {
      return next(new Error('Each line must have a debit or a credit amount.'));
    }
    dr += d;
    cr += c;
  }
  if (round2(dr) !== round2(cr)) {
    return next(
      new Error(`Entry is unbalanced: debit ${round2(dr)} ≠ credit ${round2(cr)}.`)
    );
  }
  if (round2(dr) <= 0) {
    return next(new Error('Entry total must be greater than zero.'));
  }
  next();
});

const JournalEntry = mongoose.model('JournalEntry', journalEntrySchema);

export default JournalEntry;
