import mongoose from 'mongoose';

// Day-wise booking capacity, split into morning / evening halves.
// One row with date=null is the company-wide DEFAULT (applies to every day);
// a row with a date is an HR override for just that day.
const slotCapacitySchema = mongoose.Schema(
  {
    // UTC midnight of the day this row caps; null = the company-wide default.
    date: { type: Date, default: null },
    morning: { type: Number, default: 3, min: 0 },
    evening: { type: Number, default: 3, min: 0 },
    note: { type: String, default: '' },
  },
  { timestamps: true }
);

// One row per day, plus a single default row (date:null). Sparse-unique so the
// null default is unique and each dated override is unique.
slotCapacitySchema.index({ date: 1 }, { unique: true, sparse: true });

const SlotCapacity = mongoose.model('SlotCapacity', slotCapacitySchema);

export default SlotCapacity;
