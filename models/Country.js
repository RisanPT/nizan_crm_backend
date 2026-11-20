import mongoose from 'mongoose';

// COUNTRY — the top of the marketing geography (Country → City). A lead says which country and city the bride is in; campaigns, teams
// and budgets will hang off the same list. The India-only Zone / State / Region / District list (pricing, pincodes, field work) is a
// different tree and is left as it is. Rules: utils/marketGeo.js; endpoints: controllers/countryController.js.
const countrySchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Please add a country name'], trim: true, maxlength: 60 },
    code: { type: String, trim: true, uppercase: true, default: '' }, // ISO-2: IN, AE, MY
    dialCode: { type: String, trim: true, default: '' }, // +91
    currency: { type: String, trim: true, uppercase: true, default: '' }, // INR, AED, MYR — the currency a lead's budget is read in
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  },
  { timestamps: true }
);

// One country per name, whatever the capitals.
countrySchema.index({ name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

const Country = mongoose.model('Country', countrySchema);
export default Country;
