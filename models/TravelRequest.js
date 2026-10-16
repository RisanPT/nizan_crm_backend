import mongoose from 'mongoose';

export const TRAVEL_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];
export const TRAVEL_MODES = ['flight', 'train', 'bus', 'car', 'other'];

// An employee's travel request (trip + estimated cost + optional advance),
// routed through the approval engine.
const travelRequestSchema = new mongoose.Schema(
  {
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    employeeName: { type: String, default: '' },
    department: { type: String, default: '' },
    destination: { type: String, required: true, trim: true },
    purpose: { type: String, default: '' },
    mode: { type: String, enum: TRAVEL_MODES, default: 'flight' },
    fromDate: { type: Date, default: null },
    toDate: { type: Date, default: null },
    estimatedCost: { type: Number, default: 0 },
    advanceRequested: { type: Boolean, default: false },
    advanceAmount: { type: Number, default: 0 },
    status: { type: String, enum: TRAVEL_STATUSES, default: 'pending' },
    approvalId: { type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalRequest', default: null },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

travelRequestSchema.index({ employeeId: 1, fromDate: -1 });

const TravelRequest = mongoose.model('TravelRequest', travelRequestSchema);
export default TravelRequest;
