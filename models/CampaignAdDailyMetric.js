import mongoose from 'mongoose';

// One AD's paid-ads figures for ONE day (IST), from a Meta Ads Manager AD-LEVEL export (one row per ad per day): spend, reach,
// impressions, clicks and the platform's own "results". There is no live Meta sync — these come in only through the Campaigns hub's import
// (controllers/marketingCampaignHubController.js importMetrics). One record per ad per day: importing the same day again REPLACES it.
// The campaign's own day (CampaignDailyMetric) is recomputed from these after an ad-level import, so the two always add up.

const campaignAdDailyMetricSchema = new mongoose.Schema(
  {
    adId: { type: mongoose.Schema.Types.ObjectId, ref: 'CampaignAd', required: true },
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', required: true },
    day: { type: String, required: true }, // YYYY-MM-DD (IST)
    spend: { type: Number, default: 0, min: 0 }, // ₹
    reach: { type: Number, default: 0, min: 0 },
    impressions: { type: Number, default: 0, min: 0 },
    clicks: { type: Number, default: 0, min: 0 },
    results: { type: Number, default: 0, min: 0 }, // the platform's own results (leads / messages…), shown beside the CRM's leads
    importId: { type: mongoose.Schema.Types.ObjectId, ref: 'MetaImportLog', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

campaignAdDailyMetricSchema.index({ adId: 1, day: 1 }, { unique: true });
campaignAdDailyMetricSchema.index({ campaignId: 1, day: 1 });
campaignAdDailyMetricSchema.index({ day: 1 });

export default mongoose.model('CampaignAdDailyMetric', campaignAdDailyMetricSchema);
