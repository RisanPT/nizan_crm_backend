import mongoose from 'mongoose';

// A company-wide target for one metric over one day, week or month.
//
// One document per (metric, period) — setting next month's goal never touches
// this month's, so history stays intact and a goal stays retrievable after its
// period has passed. `periodStart` is an IST calendar day ('YYYY-MM-DD'):
//   day   → that day
//   week  → the Monday of the week
//   month → the 1st of the month
// Actuals are computed live from leads / bookings / trials — see
// utils/goalMath.js and controllers/goalController.js.
export const GOAL_METRICS = ['leads', 'bookings', 'revenue', 'trials'];
export const GOAL_PERIOD_TYPES = ['day', 'week', 'month'];

const goalSchema = new mongoose.Schema(
  {
    metric: { type: String, enum: GOAL_METRICS, required: true },
    periodType: { type: String, enum: GOAL_PERIOD_TYPES, required: true },
    periodStart: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    value: { type: Number, required: true, min: 0 },
    setBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

goalSchema.index({ metric: 1, periodType: 1, periodStart: 1 }, { unique: true });
goalSchema.index({ periodType: 1, periodStart: 1 });

export default mongoose.model('Goal', goalSchema);
