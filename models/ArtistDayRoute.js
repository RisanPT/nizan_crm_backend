import mongoose from 'mongoose';

// The road between one work and the next, for one artist on one IST day (see
// utils/artistDay.js). Computed on demand by services/artistDay.js and stored so the
// map service is only asked again when a work on that day changes: `signature`
// fingerprints everything the legs depend on. Only distances and ids are kept —
// never a client's location.
const legSchema = new mongoose.Schema(
  {
    fromBookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', required: true },
    toBookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', required: true },
    km: { type: Number, default: null }, // null = couldn't be measured
    durationMin: { type: Number, default: 0 },
    approximate: { type: Boolean, default: false }, // a venue was only known to its pincode area
    note: { type: String, default: '' },
  },
  { _id: false },
);

const artistDayRouteSchema = new mongoose.Schema(
  {
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    dayKey: { type: String, required: true }, // 'YYYY-MM-DD' (IST)
    signature: { type: String, default: '' },
    legs: { type: [legSchema], default: [] },
    warnings: { type: [String], default: [] },
    calculatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

artistDayRouteSchema.index({ employeeId: 1, dayKey: 1 }, { unique: true });

const ArtistDayRoute = mongoose.model('ArtistDayRoute', artistDayRouteSchema);

export default ArtistDayRoute;
