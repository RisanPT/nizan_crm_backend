import mongoose from 'mongoose';

// Daily enquiry count the sales team types in by hand each morning, per lead
// channel — e.g. "Instagram Main page: 9 DMs yesterday/today".
//
// ONE SHARED TEAM COUNT per day per channel (not per salesperson): whoever in
// sales enters or corrects it, everyone (sales, sales head, marketing head)
// sees the same number. Every change is kept in `history`.
//
// Used two ways:
//  1. Cross-check: compared with the Lead records actually saved, so
//     enquiries that never became a lead stand out.
//  2. Sales EOD lead counts: on a day that has a manual count, the EOD lead
//     figures come from it; days without one fall back to saved leads.
//
// Channels are the canonical lead sources (Flutter kLeadSources).
export const ENQUIRY_CHANNELS = [
  'WhatsApp (Organic)',
  'IG Leads — Main Page',
  'IG Leads — Kerala Page',
  'Paid Ads Leads',
  'Trial Campaign Leads',
  'YouTube',
  'Reference',
  'Walk-in',
  'Other',
];

const historySchema = new mongoose.Schema(
  {
    from: { type: Number, default: null }, // null = first entry
    to: { type: Number, required: true },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    byName: { type: String, default: '' },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const enquiryCountSchema = new mongoose.Schema(
  {
    // IST calendar day, 'YYYY-MM-DD'.
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    channel: { type: String, required: true, enum: ENQUIRY_CHANNELS },
    count: { type: Number, required: true, min: 0, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedByName: { type: String, default: '' },
    // Change log, newest last (capped in the controller).
    history: { type: [historySchema], default: [] },
  },
  { timestamps: true }
);

// One shared row per channel per day for the whole team.
enquiryCountSchema.index({ date: 1, channel: 1 }, { unique: true });

// Separate collection from the earlier per-person draft (never deployed), so
// its old { userId, date, channel } unique index can never clash.
export default mongoose.model('EnquiryCount', enquiryCountSchema, 'team_enquiry_counts');
