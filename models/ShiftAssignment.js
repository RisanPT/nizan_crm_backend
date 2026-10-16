import mongoose from 'mongoose';

// Assigns an employee to a shift for a date range (toDate null = open-ended).
// Drives the weekly roster view; feeds the attendance expectation.
const shiftAssignmentSchema = new mongoose.Schema(
  {
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      required: true,
      index: true,
    },
    employeeName: { type: String, default: '' },
    department: { type: String, default: '' },
    shiftId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shift', required: true },
    shiftName: { type: String, default: '' },
    fromDate: { type: Date, required: true },
    toDate: { type: Date, default: null },
    note: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

shiftAssignmentSchema.index({ employeeId: 1, fromDate: -1 });

const ShiftAssignment = mongoose.model('ShiftAssignment', shiftAssignmentSchema);
export default ShiftAssignment;
