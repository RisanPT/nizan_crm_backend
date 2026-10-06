import mongoose from 'mongoose';

// A salesperson's monthly target, set by a sales manager (or admin/manager).
// Achievement is computed live from bookings — see utils/salesAchievement.js.
const salesTargetSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    month: { type: Number, required: true, min: 1, max: 12 },
    year: { type: Number, required: true },
    // Net booking value (₹) to achieve in the month. 0 = no value target.
    salesTarget: { type: Number, default: 0, min: 0 },
    // Number of bookings to close in the month. 0 = no count target.
    bookingsTarget: { type: Number, default: 0, min: 0 },
    note: { type: String, default: '', trim: true },
    setBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

salesTargetSchema.index({ userId: 1, month: 1, year: 1 }, { unique: true });

export default mongoose.model('SalesTarget', salesTargetSchema);
