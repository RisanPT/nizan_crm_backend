import mongoose from 'mongoose';

// A SAVED marketing report: one that was generated (by someone, or by a schedule) — its name, the period and brand it covers, who and
// when. The figures are not stored: opening it re-runs the module's report for that period, so it always reads the records.
const schema = new mongoose.Schema(
  {
    module: { type: String, enum: ['team', 'campaigns', 'leads'], required: true },
    kind: { type: String, required: true },
    name: { type: String, required: true },
    from: { type: String, required: true }, // 'YYYY-MM-DD' (IST)
    to: { type: String, required: true },
    brand: { type: String, enum: ['all', 'main', 'kerala'], default: 'all' },
    scheduleKey: { type: String, default: '' }, // set when a schedule made it
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdByName: { type: String, default: '' },
  },
  { timestamps: true }
);
schema.index({ module: 1, updatedAt: -1 });
schema.index({ createdBy: 1, module: 1, kind: 1, from: 1 }); // the same report made again (controllers/marketingReportsController.js createSaved)
// a schedule saves one report per period (two servers running the scheduler at once still make one)
schema.index({ scheduleKey: 1, from: 1 }, { unique: true, partialFilterExpression: { scheduleKey: { $gt: '' } } });

const MarketingSavedReport = mongoose.model('MarketingSavedReport', schema);
export default MarketingSavedReport;
