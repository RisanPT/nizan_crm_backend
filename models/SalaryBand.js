import mongoose from 'mongoose';

// A compensation grade band (salary range for a level). Reference data for the
// Compensation module; `level` aligns with Designation.level.
const salaryBandSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    level: { type: Number, default: 1 },
    minSalary: { type: Number, default: 0 },
    maxSalary: { type: Number, default: 0 },
    currency: { type: String, default: 'INR' },
    notes: { type: String, default: '' },
    active: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

salaryBandSchema.index({ level: 1 });

const SalaryBand = mongoose.model('SalaryBand', salaryBandSchema);
export default SalaryBand;
