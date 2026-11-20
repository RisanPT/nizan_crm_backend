import mongoose from 'mongoose';

// CITY — under a Country (see models/Country.js). `state` is an optional label for the state / province, shown beside the city; it is
// not a level of its own yet.
const citySchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Please add a city name'], trim: true, maxlength: 60 },
    country: { type: mongoose.Schema.Types.ObjectId, ref: 'Country', required: [true, 'Please choose a country'] },
    state: { type: String, trim: true, default: '', maxlength: 60 },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  },
  { timestamps: true }
);

// One city per name within a country, whatever the capitals.
citySchema.index({ country: 1, name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

const City = mongoose.model('City', citySchema);
export default City;
