import mongoose from 'mongoose';

// One campaign's paid-ads figures for ONE day and ONE audience / placement segment, from a Meta Ads Manager BREAKDOWN export (Breakdown →
// By delivery: Age, Gender, Age and gender, Platform / Placement). Powers the Campaigns hub's "Audiences & placements" (top segments by
// spend and results). No live Meta sync — imported only.
//  • `dimension` = the breakdown fields the file carried, joined: 'age', 'gender', 'age+gender', 'placement'… A field is read from one
//    dimension only (utils/marketingCampaignStats.js audienceSegments), so a file by age and another by age and gender never add up twice.
//  • `placement` = platform and position as Meta names them ("Instagram · Reels"); '' when the file had no placement.
// One record per campaign, day, dimension and segment: importing the same file again REPLACES the figures.

const campaignBreakdownMetricSchema = new mongoose.Schema(
  {
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', required: true },
    day: { type: String, required: true }, // YYYY-MM-DD (IST)
    dimension: { type: String, required: true, trim: true, maxlength: 40 },
    age: { type: String, default: '', trim: true, maxlength: 40 },
    gender: { type: String, default: '', trim: true, maxlength: 40 },
    placement: { type: String, default: '', trim: true, maxlength: 120 },
    spend: { type: Number, default: 0, min: 0 },
    reach: { type: Number, default: 0, min: 0 },
    impressions: { type: Number, default: 0, min: 0 },
    clicks: { type: Number, default: 0, min: 0 },
    results: { type: Number, default: 0, min: 0 },
    importId: { type: mongoose.Schema.Types.ObjectId, ref: 'MetaImportLog', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

campaignBreakdownMetricSchema.index({ campaignId: 1, day: 1, dimension: 1, age: 1, gender: 1, placement: 1 }, { unique: true });
campaignBreakdownMetricSchema.index({ day: 1 });

export default mongoose.model('CampaignBreakdownMetric', campaignBreakdownMetricSchema);
