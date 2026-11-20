import mongoose from 'mongoose';

// Sending lead results back to Meta (Conversions API, services/metaCapi.js): one record, key 'capi'. The secrets are NOT here
// (utils/metaCapi.js capiConfig).
//  • enabled: OFF until the Marketing Manager / admin switches it on — it shares the stages of Meta's leads with Meta, which the
//    business must have decided (and said so in its privacy notice).
//  • running / runningSince: one run at a time, across processes; a run older than 20 minutes is taken as dead.
const metaCapiStateSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'capi', unique: true },
    enabled: { type: Boolean, default: false },
    enabledAt: { type: Date, default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedByName: { type: String, default: '' },
    running: { type: Boolean, default: false },
    runningSince: { type: Date, default: null },
    lastRun: {
      at: { type: Date, default: null },
      trigger: { type: String, default: '' }, // auto | manual
      ok: { type: Boolean, default: false },
      problemCode: { type: String, default: '' },
      problem: { type: String, default: '' },
      planned: { type: Number, default: 0 }, // new stages found
      sent: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      skipped: { type: Number, default: 0 },
      expired: { type: Number, default: 0 },
    },
    lastSentAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export default mongoose.model('MetaCapiState', metaCapiStateSchema);
