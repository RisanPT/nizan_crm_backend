import mongoose from 'mongoose';

// One entry in the history of figures brought into the Campaigns hub: a Meta Ads Manager export that was imported (source 'csv'),
// or a day's figures typed by hand ('manual'), or a run of the live Meta sync ('api'). It is the honest "Last import: …" on the Overview's
// Meta card.

// 'api' = a run of the live Meta sync (services/metaAdsSync.js): one entry per run, `by` = who pressed Sync now (null when automatic).
export const IMPORT_SOURCES = ['csv', 'manual', 'api'];

const metaImportLogSchema = new mongoose.Schema(
  {
    source: { type: String, enum: IMPORT_SOURCES, default: 'csv' },
    // what the file was: one row per campaign per day, per AD per day, or per audience / placement segment per day
    level: { type: String, enum: ['campaign', 'ad', 'breakdown'], default: 'campaign' },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    byName: { type: String, default: '' },
    fileName: { type: String, default: '', trim: true, maxlength: 200 },
    rows: { type: Number, default: 0 }, // campaign-day rows received
    matched: { type: Number, default: 0 }, // rows that matched a campaign (or one created for them)
    unmatched: { type: Number, default: 0 }, // rows left out because no campaign matched
    unmatchedNames: { type: [String], default: [] }, // up to 50 names, for the history
    created: { type: Number, default: 0 }, // campaigns created from the file (only when the importer asked for it)
    written: { type: Number, default: 0 }, // daily records written (campaign-days, ad-days or segment-days, by level)
    adsCreated: { type: Number, default: 0 }, // ads added from an ad-level file (an ad the hub did not have yet)
    skipped: { type: Number, default: 0 }, // rows that were not valid (bad day, negative number…)
    from: { type: String, default: '' }, // first and last day in what was written
    to: { type: String, default: '' },
  },
  { timestamps: true },
);

metaImportLogSchema.index({ createdAt: -1 });

export default mongoose.model('MetaImportLog', metaImportLogSchema);
