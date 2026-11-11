import mongoose from 'mongoose';

// What a litre of petrol / diesel (a kg of CNG, a kWh of electricity) costs, from a given day —
// kept by hand by Accounts or the fleet manager (see utils/fuelPrice.js). A change of price is a NEW
// row with a later effectiveFrom, so an older bill is still held against the price of ITS day.
const fuelPriceSchema = new mongoose.Schema(
  {
    fuelType: { type: String, enum: ['petrol', 'diesel', 'cng', 'electric'], required: true },
    pricePerUnit: { type: Number, required: true, min: 0 },
    // IST day the price starts, 'YYYY-MM-DD'.
    effectiveFrom: { type: String, required: true },
    note: { type: String, default: '', trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

// one price per fuel per start day
fuelPriceSchema.index({ fuelType: 1, effectiveFrom: 1 }, { unique: true });

const FuelPrice = mongoose.model('FuelPrice', fuelPriceSchema);

export default FuelPrice;
