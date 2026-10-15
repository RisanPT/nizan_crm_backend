import mongoose from 'mongoose';

export const HIRING_PLAN_STATUSES = ['draft', 'raised', 'approved', 'rejected'];

// Hiring Plan / Requisition model.
// Implements HRMS Design FR-1.1 through FR-1.5:
// - FR-1.1: Business justification
// - FR-1.2: Job description (purpose & responsibilities)
// - FR-1.3: Required skills & qualifications
// - FR-1.4: Workflow state: draft -> raised -> approved | rejected
// - FR-1.5: Job posts and candidates can be created only against an approved plan.
// - Reporting line integration with the organizational hierarchy.
const hiringPlanSchema = new mongoose.Schema(
  {
    roleId: { type: mongoose.Schema.Types.ObjectId, ref: 'JobRole', default: null },
    designation: { type: String, required: true, trim: true },
    department: { type: String, required: true, trim: true },
    openings: { type: Number, default: 1 },
    employmentType: {
      type: String,
      enum: ['Full-time', 'Probation', 'Contract', 'Internship', 'Part-time'],
      default: 'Full-time',
    },
    reportingLine: { type: String, default: '' }, // Hierarchy supervisor (e.g. Head of Bridal, IT Head)
    businessJustification: { type: String, default: '' },
    jobDescription: { type: String, default: '' },
    requiredSkills: { type: String, default: '' },
    experienceBand: { type: String, default: '' },
    competencies: { type: String, default: '' },
    status: {
      type: String,
      enum: HIRING_PLAN_STATUSES,
      default: 'draft',
    },
    raisedAt: { type: Date, default: null },
    approvedAt: { type: Date, default: null },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    rejectionReason: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

const HiringPlan = mongoose.model('HiringPlan', hiringPlanSchema);
export default HiringPlan;
