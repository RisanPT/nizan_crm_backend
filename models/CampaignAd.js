import mongoose from 'mongoose';

// One ad (creative) inside a campaign: its name, ad set, format, the link to the creative and a thumbnail link (Drive / cloud links —
// nothing is uploaded), and the figures the Meta Ads Manager shows for it.
//  • An ad TYPED by hand carries CUMULATIVE figures (lifetime of the ad): the Creatives & Ads screen shows them as "lifetime".
//  • An ad brought in by an AD-LEVEL import (Ads Manager's export with ad and ad set columns) has a record per day (CampaignAdDailyMetric,
//    `dailyFigures` true): the screen shows the days of the selected range, and the figures below are kept as the sum of all its days.
//  • metaAdId / metaAdSetId are Meta's IDs (how an import finds the ad again, whatever it is renamed to).

export const AD_FORMATS = ['image', 'video', 'reel', 'carousel', 'story', 'other'];
export const AD_STATUSES = ['active', 'paused', 'ended'];

const campaignAdSchema = new mongoose.Schema(
  {
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', required: true },
    adSetName: { type: String, default: '', trim: true, maxlength: 160 },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    format: { type: String, enum: AD_FORMATS, default: 'image' },
    status: { type: String, enum: AD_STATUSES, default: 'active' },
    creativeUrl: { type: String, default: '', trim: true },
    thumbUrl: { type: String, default: '', trim: true },
    impressions: { type: Number, default: 0, min: 0 },
    clicks: { type: Number, default: 0, min: 0 },
    spend: { type: Number, default: 0, min: 0 }, // ₹
    results: { type: Number, default: 0, min: 0 }, // the platform's own results for the ad
    metaAdId: { type: String, default: '', trim: true, maxlength: 40 },
    metaAdSetId: { type: String, default: '', trim: true, maxlength: 40 },
    dailyFigures: { type: Boolean, default: false }, // true once an ad-level import wrote days for it
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

campaignAdSchema.index({ campaignId: 1 });
campaignAdSchema.index({ metaAdId: 1 }, { partialFilterExpression: { metaAdId: { $type: 'string', $gt: '' } } });

export default mongoose.model('CampaignAd', campaignAdSchema);
