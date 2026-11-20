import mongoose from 'mongoose';

// One campaign's paid-ads figures for ONE day (IST) — what the Meta Ads Manager reports: spend, reach, impressions, clicks and the
// platform's own "results". Typed for a day by hand, imported from a Meta Ads Manager export (CSV / Excel) in the Campaigns hub, or
// brought in by the live Meta sync. One record per campaign per day (re-importing a day replaces it), so a day's spend can never be counted twice.
// Leads, bookings and revenue are NOT here: they are the CRM's (Lead / Booking), joined through Lead.campaignId.

// csv = a campaign-level export; csv_ads = summed from an ad-level export's ads (CampaignAdDailyMetric); csv_breakdown = summed from a
// breakdown export's segments (only when the day had no other figure); manual = typed; api = Meta's own figure, from the live sync
// (services/metaAdsSync.js).
export const METRIC_SOURCES = ['csv', 'csv_ads', 'csv_breakdown', 'manual', 'api'];

const campaignDailyMetricSchema = new mongoose.Schema(
  {
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', required: true },
    day: { type: String, required: true }, // YYYY-MM-DD (IST)
    spend: { type: Number, default: 0, min: 0 }, // ₹
    reach: { type: Number, default: 0, min: 0 },
    impressions: { type: Number, default: 0, min: 0 },
    clicks: { type: Number, default: 0, min: 0 },
    results: { type: Number, default: 0, min: 0 }, // what the platform counts as results (leads / messages…): shown beside the CRM's leads, never mixed in
    source: { type: String, enum: METRIC_SOURCES, default: 'manual' },
    importId: { type: mongoose.Schema.Types.ObjectId, ref: 'MetaImportLog', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

campaignDailyMetricSchema.index({ campaignId: 1, day: 1 }, { unique: true });
campaignDailyMetricSchema.index({ day: 1 });

export default mongoose.model('CampaignDailyMetric', campaignDailyMetricSchema);
