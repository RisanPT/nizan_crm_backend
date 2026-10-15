import mongoose from 'mongoose';

const dayProgressSchema = new mongoose.Schema(
  {
    dayNumber: { type: Number, required: true },
    title: { type: String, required: true },
    topics: [{ type: String }],
    signedOff: { type: Boolean, default: false },
    signedOffBy: { type: String, default: '' },
    signedOffAt: { type: Date, default: null },
    status: { type: String, enum: ['Signed', 'In progress', 'Upcoming', 'Pending'], default: 'Upcoming' },
    notes: { type: String, default: '' },
  },
  { _id: false }
);

// Active employee orientation instance
const orientationAssignmentSchema = new mongoose.Schema(
  {
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    employeeName: { type: String, required: true },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrientationPlan', default: null },
    roleTitle: { type: String, required: true },
    department: { type: String, default: '' },
    trainerName: { type: String, default: 'Department Lead' },
    startDate: { type: Date, default: Date.now },
    currentDay: { type: Number, default: 1 },
    totalDays: { type: Number, default: 7 },
    status: { type: String, enum: ['On track', 'Due today', 'Overdue', 'Completed'], default: 'On track' },
    days: [dayProgressSchema],
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

const OrientationAssignment = mongoose.model('OrientationAssignment', orientationAssignmentSchema);
export default OrientationAssignment;
