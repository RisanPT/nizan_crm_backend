import mongoose from 'mongoose';

// One upload of a GPS km report — who, when, what was in it. The readings themselves are
// in GpsKmReading.
const vehicleSchema = new mongoose.Schema(
  {
    registrationNumber: { type: String, default: '' },
    vehicleName: { type: String, default: '' }, // the CRM vehicle it matched, '' = none
    days: { type: Number, default: 0 },
  },
  { _id: false },
);

const gpsKmUploadSchema = new mongoose.Schema(
  {
    fileName: { type: String, default: '', trim: true },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    uploadedByName: { type: String, default: '' },
    from: { type: String, default: '' }, // first / last day in the file
    to: { type: String, default: '' },
    rows: { type: Number, default: 0 },
    created: { type: Number, default: 0 },
    updated: { type: Number, default: 0 },
    unchanged: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 },
    vehicles: { type: [vehicleSchema], default: [] },
  },
  { timestamps: true },
);

gpsKmUploadSchema.index({ createdAt: -1 });

const GpsKmUpload = mongoose.model('GpsKmUpload', gpsKmUploadSchema);

export default GpsKmUpload;
