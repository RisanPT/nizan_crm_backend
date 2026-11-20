import mongoose from 'mongoose';

// The Instagram insights sync (services/metaIgSync.js): one record, key 'ig'. The secrets are NOT here (utils/metaIg.js igConfig).
//  • autoSync: every 6 hours the last 30 days' posts are read again. The Marketing Manager / admin switches it.
//  • running / runningSince: one run at a time, across processes; a run older than 30 minutes is taken as dead.
//  • unmatched: Instagram posts that match no Socials post — listed (with their figures, so adding one needs no new call) until the
//    team adds, links or hides each. ignored: post ids the team chose not to see.
const unmatchedSchema = new mongoose.Schema(
  {
    mediaId: { type: String, required: true },
    accountId: { type: String, default: '' },
    username: { type: String, default: '' },
    brand: { type: String, default: 'main' },
    contentType: { type: String, default: 'post' },
    caption: { type: String, default: '' },
    permalink: { type: String, default: '' },
    thumbUrl: { type: String, default: '' },
    at: { type: Date, default: null },
    metrics: {
      reach: { type: Number, default: 0 },
      views: { type: Number, default: 0 },
      likes: { type: Number, default: 0 },
      comments: { type: Number, default: 0 },
      shares: { type: Number, default: 0 },
      saves: { type: Number, default: 0 },
    },
  },
  { _id: false },
);

const metaIgSyncSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'ig', unique: true },
    autoSync: { type: Boolean, default: true },
    running: { type: Boolean, default: false },
    runningSince: { type: Date, default: null },
    lastRun: {
      at: { type: Date, default: null },
      doneAt: { type: Date, default: null },
      trigger: { type: String, default: '' }, // auto | manual
      byName: { type: String, default: '' },
      days: { type: Number, default: 0 },
      ok: { type: Boolean, default: false },
      problemCode: { type: String, default: '' },
      problem: { type: String, default: '' },
      accounts: { type: Number, default: 0 },
      media: { type: Number, default: 0 }, // posts read
      updated: { type: Number, default: 0 }, // Socials posts whose figures were written
      linked: { type: Number, default: 0 }, // of those, newly linked this run (by link or by day)
      unmatched: { type: Number, default: 0 },
      gaps: { type: Number, default: 0 }, // posts whose insights Meta would not give (their like / comment counts were used)
    },
    lastOkAt: { type: Date, default: null },
    unmatched: { type: [unmatchedSchema], default: [] },
    ignored: { type: [String], default: [] },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedByName: { type: String, default: '' },
  },
  { timestamps: true },
);

export default mongoose.model('MetaIgSync', metaIgSyncSchema);
