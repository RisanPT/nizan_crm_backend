import mongoose from 'mongoose';

export const CAMPAIGN_BRANDS = ['main', 'kerala'];
export const CAMPAIGN_PLATFORMS = ['meta', 'instagram', 'facebook', 'google', 'youtube', 'whatsapp', 'other'];
export const CAMPAIGN_OBJECTIVES = ['lead_generation', 'messages', 'engagement', 'reach', 'traffic', 'conversions', 'other'];

// A marketing campaign with its costs (ad spend + production) and the revenue it
// generated — the basis for campaign ROI / ROAS.
const campaignSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    channel: { type: String, default: '', trim: true }, // Instagram, Google, Meta…
    status: {
      type: String,
      enum: ['planned', 'active', 'paused', 'completed'],
      default: 'active',
    },
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null },
    // Costs.
    adSpend: { type: Number, default: 0, min: 0 },
    productionCost: { type: Number, default: 0, min: 0 },
    // Return + funnel.
    revenue: { type: Number, default: 0, min: 0 }, // revenue attributed to the campaign
    leads: { type: Number, default: 0, min: 0 },
    conversions: { type: Number, default: 0, min: 0 },
    notes: { type: String, default: '', trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    // ── Added for the Marketing ERP's Campaigns hub (routes/marketingCampaignHubRoutes.js). Every field is optional with a default, so
    // campaigns made on the old Campaigns screen keep working and show up here as "Main", platform/objective "not set", "No budget set".
    // The Meta Ads spend / reach / impressions / clicks of a campaign are NOT stored here: they are daily records (CampaignDailyMetric).
    // The Marketing ERP's Main / Kerala filter. A NEW campaign is Kerala unless the form says otherwise — the ads run only on the Kerala
    // account — and every place that creates one sets it (utils/marketingCampaignInput.js, controllers/campaignController.js, the Meta import).
    // The schema default stays 'main' on purpose: Mongoose also applies a default to an OLD document that has no brand when it is loaded,
    // and campaigns made before the field existed are read as Main everywhere (utils/marketingOutcomes.js brandOfCampaign).
    brand: { type: String, enum: CAMPAIGN_BRANDS, default: 'main' },
    platform: { type: String, enum: [...CAMPAIGN_PLATFORMS, ''], default: '' }, // normalised; the free-text `channel` above is the old, typed spelling
    objective: { type: String, enum: [...CAMPAIGN_OBJECTIVES, ''], default: '' }, // Lead Generation, Messages, Engagement, Reach…
    budget: { type: Number, default: 0, min: 0 }, // the campaign's total budget; 0 = no budget set (nothing is invented)
    dailyBudget: { type: Number, default: 0, min: 0 },
    metaCampaignId: { type: String, default: '', trim: true }, // matches the rows of a Meta Ads Manager export to this campaign
    audienceNote: { type: String, default: '', trim: true }, // who the campaign is aimed at, in the team's own words
  },
  { timestamps: true }
);

campaignSchema.index({ brand: 1, status: 1 });
// one campaign per Meta ID (only campaigns that have one): the import matches by it
campaignSchema.index({ metaCampaignId: 1 }, { unique: true, partialFilterExpression: { metaCampaignId: { $type: 'string', $gt: '' } } });

const Campaign = mongoose.model('Campaign', campaignSchema);

export default Campaign;
