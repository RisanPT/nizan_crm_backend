import mongoose from 'mongoose';

// How much may be spent on a meal PER HEAD (Accounts sets it; see utils/foodAllowance.js).
// A rule can be limited to a date range (IST days, 'YYYY-MM-DD'; empty = open). Switching a
// rule off keeps it; deleting it removes it for good.
const foodAllowanceSchema = new mongoose.Schema(
  {
    meal: { type: String, enum: ['breakfast', 'lunch', 'snacks', 'dinner', 'early_breakfast'], required: true },
    amountPerHead: { type: Number, required: true, min: 0 },
    effectiveFrom: { type: String, default: '' },
    effectiveTo: { type: String, default: '' },
    active: { type: Boolean, default: true },
    note: { type: String, default: '', trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

foodAllowanceSchema.index({ meal: 1, active: 1 });

const FoodAllowance = mongoose.model('FoodAllowance', foodAllowanceSchema);

export default FoodAllowance;
