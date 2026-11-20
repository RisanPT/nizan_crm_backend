import mongoose from 'mongoose';

// One stage of one Meta lead, to be told to Meta through the Conversions API (services/metaCapi.js) — the outbox. Unique per Meta lead and
// stage, so a stage is never sent twice however often the sweep runs.
//   pending → sent | failed (reason; tried again, alone, while `retry`) | skipped (older than Meta's 7 days when first seen) |
//   expired (it grew older than 7 days before Meta took it)
export const CAPI_EVENT_STATUSES = ['pending', 'sent', 'failed', 'skipped', 'expired'];

const metaCapiEventSchema = new mongoose.Schema(
  {
    leadgenId: { type: String, required: true, trim: true }, // Meta's lead id
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', required: true },
    leadName: { type: String, default: '' },
    stage: { type: String, required: true }, // utils/metaCapi.js CAPI_STAGES
    eventTime: { type: Number, required: true }, // Unix seconds, as sent
    status: { type: String, enum: CAPI_EVENT_STATUSES, default: 'pending' },
    attempts: { type: Number, default: 0 },
    retry: { type: Boolean, default: true },
    nextTryAt: { type: Date, default: null },
    problemCode: { type: String, default: '' },
    problem: { type: String, default: '' },
    sentAt: { type: Date, default: null },
    fbtraceId: { type: String, default: '' },
    test: { type: Boolean, default: false }, // sent with Events Manager's test code: shows under Test events, counts for nothing
  },
  { timestamps: true },
);

metaCapiEventSchema.index({ leadgenId: 1, stage: 1 }, { unique: true });
metaCapiEventSchema.index({ status: 1, nextTryAt: 1 });
metaCapiEventSchema.index({ createdAt: -1 });

export default mongoose.model('MetaCapiEvent', metaCapiEventSchema);
