import mongoose from 'mongoose';

// A single posted depreciation run: the depreciation charged across all
// depreciable assets up to `periodEnd`, and the ledger voucher it posted.
const depreciationRunSchema = mongoose.Schema(
  {
    // Depreciation is computed as-of this date (typically a month/year end).
    periodEnd: { type: Date, required: true },
    // The Dr Depreciation / Cr Accumulated Depreciation voucher this run posted.
    journalEntry: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
      default: null,
    },
    totalAmount: { type: Number, default: 0 },
    // Per-asset breakdown of what was charged in this run.
    lines: [
      {
        asset: { type: mongoose.Schema.Types.ObjectId, ref: 'Asset' },
        assetName: { type: String, default: '' },
        method: { type: String, default: '' },
        amount: { type: Number, default: 0 }, // charged this run
        accumulatedAfter: { type: Number, default: 0 },
        bookValueAfter: { type: Number, default: 0 },
      },
    ],
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

const DepreciationRun = mongoose.model('DepreciationRun', depreciationRunSchema);

export default DepreciationRun;
