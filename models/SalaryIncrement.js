import mongoose from 'mongoose';

const incrementSchema = mongoose.Schema(
  {
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      required: true,
    },
    previousSalary: {
      type: Number,
      required: true,
    },
    newSalary: {
      type: Number,
      required: true,
    },
    reason: {
      type: String,
      default: '',
    },
    effectiveDate: {
      type: Date,
      default: Date.now,
    },
    appliedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

const SalaryIncrement = mongoose.model('SalaryIncrement', incrementSchema);

export default SalaryIncrement;
