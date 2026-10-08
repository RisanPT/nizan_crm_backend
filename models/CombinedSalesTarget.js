import mongoose from 'mongoose';

// A combined (pool) sales target: one goal the whole sales team works toward
// together — every salesperson's sales in the window count. Optional package
// filter and any date window (a month, a festival campaign…). Achievement is
// computed live from bookings — see utils/salesAchievement.js.
const combinedSalesTargetSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    // Inclusive IST calendar days, 'YYYY-MM-DD'.
    startDay: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    endDay: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    // Net booking value (₹) to reach together. 0 = no value goal.
    salesTarget: { type: Number, default: 0, min: 0 },
    // Number of bookings to reach together. 0 = no count goal.
    bookingsTarget: { type: Number, default: 0, min: 0 },
    // Package family ('Airbrush', 'Platinum' …); '' = every package.
    service: { type: String, default: '', trim: true },
    note: { type: String, default: '', trim: true },
    setBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

combinedSalesTargetSchema.index({ startDay: 1, endDay: 1 });

export default mongoose.model('CombinedSalesTarget', combinedSalesTargetSchema);
