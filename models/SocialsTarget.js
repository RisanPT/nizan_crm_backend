import mongoose from 'mongoose';

// (Not the EOD module's MarketingTarget, which is a member's monthly target.)
// A target for a period — e.g. "26 reels posted in the week of 2 Nov" for the Socials activity tracker. A target is stored FOR a period
// and never overwritten by a later one: a new week's target is a new row, and a week with none inherits the latest earlier one.
// `period` is the Monday of the week (IST day string).
const socialsTargetSchema = new mongoose.Schema(
  {
    scope: { type: String, enum: ['socials'], default: 'socials' },
    brand: { type: String, enum: ['main', 'kerala', 'all'], default: 'all' },
    period: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    metricId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingMetric', required: true },
    target: { type: Number, required: true, min: 0, max: 1e7 },
    setBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

socialsTargetSchema.index({ scope: 1, brand: 1, period: 1, metricId: 1 }, { unique: true });

export default mongoose.model('SocialsTarget', socialsTargetSchema);
