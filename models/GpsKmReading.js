import mongoose from 'mongoose';

// One vehicle's distance for one day, as the GPS tracker's day-wise report gives it.
// Keyed by the NORMALISED plate (utils/gpsKm.js regKey), not a Vehicle id, so rows
// uploaded before a vehicle is added to the CRM still match once it is. Re-uploading an
// overlapping report updates these rows rather than adding new ones.
const gpsKmReadingSchema = new mongoose.Schema(
  {
    regKey: { type: String, required: true },
    registrationNumber: { type: String, required: true, trim: true }, // as the report wrote it
    dayKey: { type: String, required: true }, // 'YYYY-MM-DD'
    distanceKm: { type: Number, required: true, min: 0 },
    runningHours: { type: Number, default: null },
    stopHours: { type: Number, default: null },
    idleHours: { type: Number, default: null },
    startAddress: { type: String, default: '' },
    endAddress: { type: String, default: '' },
    uploadId: { type: mongoose.Schema.Types.ObjectId, ref: 'GpsKmUpload', default: null },
  },
  { timestamps: true },
);

gpsKmReadingSchema.index({ regKey: 1, dayKey: 1 }, { unique: true });
gpsKmReadingSchema.index({ dayKey: 1 });

const GpsKmReading = mongoose.model('GpsKmReading', gpsKmReadingSchema);

export default GpsKmReading;
