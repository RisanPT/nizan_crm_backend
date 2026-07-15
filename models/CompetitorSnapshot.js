import mongoose from 'mongoose';

// One weekly reading for a competitor. `weekOf` is normalised to the Monday of
// the week. Numeric fields feed the master DB; boolean flags drive the 1-25
// Weekly Growth Score.
const snapshotSchema = new mongoose.Schema(
  {
    competitor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Competitor',
      required: true,
    },
    weekOf: { type: Date, required: true },

    // ── Master-DB metrics ──
    followers: { type: Number, default: 0 },
    weeklyGrowthPct: { type: Number, default: 0 },
    engagementRate: { type: Number, default: 0 },
    adCampaigns: { type: Number, default: 0 },
    offers: { type: Number, default: 0 },
    newServicesCount: { type: Number, default: 0 },
    postingFrequency: { type: Number, default: 0 }, // posts / week
    seoScore: { type: Number, default: 0 },
    reviews: { type: Number, default: 0 },
    collaborations: { type: Number, default: 0 },
    contentThemes: { type: String, default: '', trim: true },

    // ── Scoring flags (this week) ──
    newCampaign: { type: Boolean, default: false }, // +6
    viralContent: { type: Boolean, default: false }, // +5
    qualityCreative: { type: Boolean, default: false }, // +5
    followerGrowth: { type: Boolean, default: false }, // +3
    engagementIncrease: { type: Boolean, default: false }, // +3
    newService: { type: Boolean, default: false }, // +2
    newPartnership: { type: Boolean, default: false }, // +2

    // Deterministic Weekly Growth Score (1-25), computed on save.
    score: { type: Number, default: 0 },

    notes: { type: String, default: '', trim: true },
  },
  { timestamps: true }
);

// One snapshot per competitor per week.
snapshotSchema.index({ competitor: 1, weekOf: 1 }, { unique: true });

const CompetitorSnapshot = mongoose.model(
  'CompetitorSnapshot',
  snapshotSchema
);

export default CompetitorSnapshot;
