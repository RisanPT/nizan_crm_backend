import mongoose from 'mongoose';

// A finding entered by a member (Strategies & Developments → Research & Insights): a research report, a market insight, a competitor
// note or an opportunity — "Research and Insights collects findings entered by members". The file itself lives elsewhere (a Drive
// link); only the link and the summary are kept here.
export const FINDING_KINDS = ['report', 'market_insight', 'competitor', 'opportunity'];

const researchFindingSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    kind: { type: String, enum: FINDING_KINDS, required: true },
    summary: { type: String, default: '', trim: true, maxlength: 2000 },
    link: { type: String, default: '', trim: true, maxlength: 1000 }, // http(s) only (checked on input)
    brand: { type: String, enum: ['main', 'kerala'], default: 'main' },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ }, // the day it was found (IST), what the date range filters on
    tags: { type: [{ type: String, trim: true, maxlength: 40 }], default: [] },
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingTeamMember', default: null },
    authorName: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

researchFindingSchema.index({ date: 1, brand: 1 });
researchFindingSchema.index({ kind: 1 });

export default mongoose.model('ResearchFinding', researchFindingSchema);
