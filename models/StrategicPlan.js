import mongoose from 'mongoose';

// A strategic plan (Strategies & Developments → Strategic Plans): one strategy for a focus area and a year, with the goals it is
// meant to reach. A plan does not carry a progress number: Strategic Plans counts plans by status; the work that serves a plan is its
// initiatives and projects (their `planId`), whose progress is counted from their tasks (utils/marketingStrategyStats.js).
export const PLAN_STATUSES = ['active', 'in_progress', 'on_hold', 'completed'];

const strategicPlanSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    focusArea: { type: String, required: true, trim: true, maxlength: 120 },
    year: { type: Number, required: true, min: 2000, max: 2100 },
    brand: { type: String, enum: ['main', 'kerala'], default: 'main' },
    status: { type: String, enum: PLAN_STATUSES, default: 'active' },
    goals: { type: [{ type: String, trim: true, maxlength: 200 }], default: [] },
    description: { type: String, default: '', trim: true, maxlength: 1000 },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingTeamMember', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    lastEditedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

strategicPlanSchema.index({ brand: 1, year: 1 });

export default mongoose.model('StrategicPlan', strategicPlanSchema);
