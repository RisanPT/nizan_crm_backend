import mongoose from 'mongoose';

// One driver's planned route for one IST day (see utils/dayTrip.js for the
// rules). Computed on demand by services/dayTrip.js and stored so the map
// service is only asked again when a work on that day changes: `signature`
// fingerprints everything the plan depends on.
const legSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['out', 'between', 'return', 'estimate'], required: true },
    from: { type: String, default: '' },
    to: { type: String, default: '' },
    km: { type: Number, default: null }, // null = couldn't be measured
    durationMin: { type: Number, default: 0 },
    mirrored: { type: Boolean, default: false }, // the way back of a single work = the way out
    note: { type: String, default: '' },
  },
  { _id: false },
);

const stopSchema = new mongoose.Schema(
  {
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', required: true },
    label: { type: String, default: '' },
    located: { type: Boolean, default: false },
    approximate: { type: Boolean, default: false },
    km: { type: Number, default: 0 }, // this work's share of the day's planned km
  },
  { _id: false },
);

const dayTripSchema = new mongoose.Schema(
  {
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    dayKey: { type: String, required: true }, // 'YYYY-MM-DD' (IST)
    signature: { type: String, default: '' },
    rule: { type: String, enum: ['none', 'round_trip', 'multi_stop'], default: 'none' },
    stops: { type: [stopSchema], default: [] },
    legs: { type: [legSchema], default: [] },
    plannedKm: { type: Number, default: 0 },
    plannedMin: { type: Number, default: 0 },
    // True when any location was only an area (pincode) or a leg couldn't be measured.
    approximate: { type: Boolean, default: false },
    warnings: { type: [String], default: [] },
    // Set when the whole plan couldn't be built (e.g. the distance service isn't configured).
    planError: { type: String, default: '' },
    calculatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

dayTripSchema.index({ driverId: 1, dayKey: 1 }, { unique: true });

const DayTrip = mongoose.model('DayTrip', dayTripSchema);

export default DayTrip;
