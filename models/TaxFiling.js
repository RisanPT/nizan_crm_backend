import mongoose from 'mongoose';

// Statutory returns tracked for compliance. `period` is the month the filing is
// FOR (for a quarterly TDS return it's the quarter-END month: 3/6/9/12).
export const FILING_TYPES = ['gstr1', 'gstr3b', 'tds_payment', 'tds_return'];

export const FILING_LABELS = {
  gstr1: 'GSTR-1 (outward supplies)',
  gstr3b: 'GSTR-3B (summary + tax payment)',
  tds_payment: 'TDS payment',
  tds_return: 'TDS return (quarterly)',
};

const taxFilingSchema = mongoose.Schema(
  {
    type: { type: String, enum: FILING_TYPES, required: true },
    periodMonth: { type: Number, min: 1, max: 12, required: true },
    periodYear: { type: Number, required: true },
    // Saved rows represent a filing the user has recorded (usually 'filed').
    status: { type: String, enum: ['pending', 'filed'], default: 'filed' },
    dueDate: { type: Date, default: null },
    filedDate: { type: Date, default: null },
    // Acknowledgement / ARN number from the GST/TDS portal.
    arn: { type: String, default: '', trim: true },
    amount: { type: Number, default: 0 },
    notes: { type: String, default: '', trim: true },
    filedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

// One record per return per period.
taxFilingSchema.index({ type: 1, periodYear: 1, periodMonth: 1 }, { unique: true });

const TaxFiling = mongoose.model('TaxFiling', taxFilingSchema);

export default TaxFiling;
