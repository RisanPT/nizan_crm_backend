import mongoose from 'mongoose';

// One lead that Meta told us about (Lead Ads form → webhook, or found by "Check for missed leads"). Kept so the same lead is never
// made twice (unique leadgenId: Meta re-sends a webhook it thinks was missed), so a lead Meta could not give us is tried again, and so
// the Marketing team can see what came in. The answers themselves live on the CRM lead; only the name / e-mail are kept here, for a
// lead that could not become one (no phone number).
//   received → working → created (a new CRM lead) | existing (her number was already a lead: noted on it) | failed (reason; retried
//   on its own while `retry`, up to utils/metaLeads.js META_MAX_ATTEMPTS)
export const META_EVENT_STATUSES = ['received', 'working', 'created', 'existing', 'failed'];
export const META_EVENT_VIA = ['webhook', 'check'];

const metaLeadEventSchema = new mongoose.Schema(
  {
    leadgenId: { type: String, required: true, trim: true },
    pageId: { type: String, default: '', trim: true },
    formId: { type: String, default: '', trim: true },
    adId: { type: String, default: '', trim: true },
    adsetId: { type: String, default: '', trim: true },
    metaCampaignId: { type: String, default: '', trim: true },
    via: { type: String, enum: META_EVENT_VIA, default: 'webhook' },
    submittedAt: { type: Date, default: null }, // when she sent the form (Meta's created_time)

    status: { type: String, enum: META_EVENT_STATUSES, default: 'received' },
    workingSince: { type: Date, default: null },
    attempts: { type: Number, default: 0 },
    nextTryAt: { type: Date, default: null },
    problemCode: { type: String, default: '' },
    problemText: { type: String, default: '' },
    retry: { type: Boolean, default: true },
    doneAt: { type: Date, default: null },

    // What the team sees in the list
    leadName: { type: String, default: '', trim: true },
    email: { type: String, default: '', trim: true }, // only for a form without a phone number
    formName: { type: String, default: '', trim: true },
    adName: { type: String, default: '', trim: true },
    campaignName: { type: String, default: '', trim: true },
    platform: { type: String, default: '', trim: true }, // fb | ig
    isOrganic: { type: Boolean, default: false },

    leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', default: null },
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', default: null }, // our campaign, when its Meta id matched
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    assignedToName: { type: String, default: '' },
  },
  { timestamps: true },
);

metaLeadEventSchema.index({ leadgenId: 1 }, { unique: true });
metaLeadEventSchema.index({ status: 1, nextTryAt: 1 });
metaLeadEventSchema.index({ createdAt: -1 });

export default mongoose.model('MetaLeadEvent', metaLeadEventSchema);
