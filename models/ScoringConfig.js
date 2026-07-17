import mongoose from 'mongoose';

// Versioned Growth-Score weights (FR-2.3). A weight change creates a NEW active
// version and applies from the next run only — historical scores are never
// retroactively recomputed.
const scoringConfigSchema = new mongoose.Schema(
  {
    version: { type: Number, required: true },
    weights: {
      newCampaign: { type: Number, default: 5 },
      viralContent: { type: Number, default: 5 },
      qualityCreative: { type: Number, default: 5 },
      followerGrowth: { type: Number, default: 3 },
      engagementIncrease: { type: Number, default: 3 },
      newService: { type: Number, default: 2 },
      newPartnership: { type: Number, default: 2 },
    },
    active: { type: Boolean, default: true },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    note: { type: String, default: '', trim: true },
  },
  { timestamps: true }
);

const ScoringConfig = mongoose.model('ScoringConfig', scoringConfigSchema);

export default ScoringConfig;
