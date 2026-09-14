import mongoose from 'mongoose';

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
  },
  { timestamps: true }
);

const Campaign = mongoose.model('Campaign', campaignSchema);

export default Campaign;
