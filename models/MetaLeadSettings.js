import mongoose from 'mongoose';

// The Meta Lead Ads choices the team makes in the app (one record, key 'meta'). The secrets are NOT here: they are the server's
// environment (utils/metaLeads.js metaConfig).
//  • assignMode: 'none' = a new Meta lead waits unassigned for a manager; 'rotate' = it goes to the people in rotateUserIds in turn
//    (rotateCounter counts the turns, moved atomically so two leads at once never land on the same turn).
//  • pageIds: the Facebook Pages "Check for missed leads" reads — every Page that sends a lead is added on its own.
export const META_ASSIGN_MODES = ['none', 'rotate'];

const metaLeadSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'meta', unique: true },
    assignMode: { type: String, enum: META_ASSIGN_MODES, default: 'none' },
    rotateUserIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    rotateCounter: { type: Number, default: 0 },
    pageIds: [{ type: String, trim: true }],
    lastCheck: {
      at: { type: Date, default: null },
      byName: { type: String, default: '' },
      days: { type: Number, default: 0 },
      forms: { type: Number, default: 0 },
      found: { type: Number, default: 0 },
      added: { type: Number, default: 0 },
      already: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      problem: { type: String, default: '' },
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedByName: { type: String, default: '' },
  },
  { timestamps: true },
);

export default mongoose.model('MetaLeadSettings', metaLeadSettingsSchema);
