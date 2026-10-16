import mongoose from 'mongoose';

export const OFFBOARDING_STATUSES = ['in_progress', 'completed'];
export const OFFBOARDING_REASONS = ['resignation', 'termination', 'retirement', 'end_of_contract', 'other'];

export const DEFAULT_CLEARANCE_ITEMS = [
  'Return assets / kit',
  'Revoke system access',
  'Handover of work',
  'Clear advances / dues',
  'Exit interview',
];

const clearanceSchema = new mongoose.Schema(
  {
    label: { type: String, required: true },
    cleared: { type: Boolean, default: false },
    owner: { type: String, default: '' },
  },
  { _id: false }
);

// An employee's exit: clearance checklist + final settlement + experience
// letter. Completing it marks the Employee inactive.
const offboardingSchema = new mongoose.Schema(
  {
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    employeeName: { type: String, default: '' },
    department: { type: String, default: '' },
    reason: { type: String, enum: OFFBOARDING_REASONS, default: 'resignation' },
    initiatedOn: { type: Date, default: Date.now },
    lastWorkingDay: { type: Date, default: null },
    status: { type: String, enum: OFFBOARDING_STATUSES, default: 'in_progress' },
    clearanceItems: { type: [clearanceSchema], default: [] },
    finalSettlementAmount: { type: Number, default: 0 },
    settlementPaid: { type: Boolean, default: false },
    experienceLetterIssued: { type: Boolean, default: false },
    notes: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

const Offboarding = mongoose.model('Offboarding', offboardingSchema);
export default Offboarding;
