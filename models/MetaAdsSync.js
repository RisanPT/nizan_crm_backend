import mongoose from 'mongoose';

// The live Meta ad spend sync (services/metaAdsSync.js): one record, key 'ads'. The secrets are NOT here (utils/metaAds.js adsConfig).
//  • autoSync: every 6 hours the last 3 days are brought in again (Meta keeps adjusting recent days). The Marketing Manager / admin
//    switches it.
//  • running / runningSince: one run at a time, across processes; a run older than 30 minutes is taken as dead.
//  • lastRun: what the latest run did, or why it failed (in words the team can act on).
//  • unlinked: Meta campaigns that spent money but match no CRM campaign — their spend is NOT counted until someone links one to a
//    campaign or adds it as a new one (the same rule as the file import: campaigns are never created unasked). ignored: ids the team
//    chose not to see (a test campaign).
const unlinkedSchema = new mongoose.Schema(
  {
    metaId: { type: String, required: true },
    name: { type: String, default: '' },
    accountId: { type: String, default: '' },
    brand: { type: String, default: 'kerala' },
    reason: { type: String, default: 'no_match' }, // no_match | ambiguous (two CRM campaigns share its title)
    firstDay: { type: String, default: '' },
    lastDay: { type: String, default: '' },
    spend: { type: Number, default: 0 }, // in the latest run that saw it (runFrom..runTo)
    runFrom: { type: String, default: '' },
    runTo: { type: String, default: '' },
  },
  { _id: false },
);

const metaAdsSyncSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'ads', unique: true },
    autoSync: { type: Boolean, default: true },
    running: { type: Boolean, default: false },
    runningSince: { type: Date, default: null },
    lastRun: {
      at: { type: Date, default: null },
      doneAt: { type: Date, default: null },
      trigger: { type: String, default: '' }, // auto | manual | link
      byName: { type: String, default: '' },
      from: { type: String, default: '' },
      to: { type: String, default: '' },
      ok: { type: Boolean, default: false },
      problemCode: { type: String, default: '' },
      problem: { type: String, default: '' },
      accounts: { type: Number, default: 0 },
      campaigns: { type: Number, default: 0 }, // CRM campaigns that got figures
      campaignDays: { type: Number, default: 0 },
      adDays: { type: Number, default: 0 },
      segments: { type: Number, default: 0 },
      adsCreated: { type: Number, default: 0 },
      spend: { type: Number, default: 0 }, // written to CRM campaigns
      unlinkedSpend: { type: Number, default: 0 }, // seen on campaigns no CRM campaign matches
      importId: { type: mongoose.Schema.Types.ObjectId, ref: 'MetaImportLog', default: null },
    },
    lastOkAt: { type: Date, default: null },
    unlinked: { type: [unlinkedSchema], default: [] },
    ignored: { type: [String], default: [] },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedByName: { type: String, default: '' },
  },
  { timestamps: true },
);

export default mongoose.model('MetaAdsSync', metaAdsSyncSchema);
