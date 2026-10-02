import mongoose from 'mongoose';

// Cached geocoding results (OpenStreetMap / Nominatim) so each place is looked
// up once. Only public place keys are stored (e.g. an Indian pincode) — never
// client names, phones or addresses.
const geoCacheSchema = new mongoose.Schema(
  {
    // e.g. 'pin:673001'
    key: { type: String, required: true, unique: true, index: true },
    status: { type: String, enum: ['ok', 'not_found', 'error'], default: 'ok' },
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
    // Human label from OSM, e.g. 'Kozhikode' / 'Feroke'.
    label: { type: String, default: '' },
    district: { type: String, default: '' },
    attempts: { type: Number, default: 1 },
  },
  { timestamps: true }
);

const GeoCache = mongoose.model('GeoCache', geoCacheSchema);

export default GeoCache;
