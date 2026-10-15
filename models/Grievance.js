import mongoose from 'mongoose';

export const GRIEVANCE_CATEGORIES = ['workplace', 'harassment', 'payroll', 'facilities', 'management', 'other'];
export const GRIEVANCE_STATUSES = ['open', 'in_review', 'resolved', 'closed'];

// An employee-raised grievance / complaint. Confidential ones are visible only
// to full-access HR (admins/managers), not department heads.
const grievanceSchema = new mongoose.Schema(
  {
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    employeeName: { type: String, default: '' },
    department: { type: String, default: '' },
    category: { type: String, enum: GRIEVANCE_CATEGORIES, default: 'other' },
    subject: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    confidential: { type: Boolean, default: false },
    status: { type: String, enum: GRIEVANCE_STATUSES, default: 'open' },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    resolutionNote: { type: String, default: '' },
    resolvedOn: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

grievanceSchema.index({ status: 1, createdAt: -1 });

const Grievance = mongoose.model('Grievance', grievanceSchema);
export default Grievance;
