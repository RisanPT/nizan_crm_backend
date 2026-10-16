import mongoose from 'mongoose';

export const OFFER_STATUSES = ['draft', 'sent', 'accepted', 'declined', 'withdrawn'];

// An offer extended to a candidate. On acceptance the recruitment controller
// creates the Employee (and kicks off onboarding) and links employeeId here.
const offerSchema = new mongoose.Schema(
  {
    candidateId: { type: mongoose.Schema.Types.ObjectId, ref: 'Candidate', required: true },
    candidateName: { type: String, default: '' },
    jobPostId: { type: mongoose.Schema.Types.ObjectId, ref: 'JobPost', default: null },
    designation: { type: String, default: '' },
    designationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Designation', default: null },
    department: { type: String, default: '' },
    salary: { type: Number, default: 0 }, // monthly net / ctc
    basicSalary: { type: Number, default: 0 },
    hra: { type: Number, default: 0 },
    incentive: { type: Number, default: 0 },
    incentiveNote: { type: String, default: '' },
    reportingTo: { type: String, default: 'HR Manager' },
    probationMonths: { type: Number, default: 3 },
    responsibilities: [{ type: String }],
    joiningDate: { type: Date, default: null },
    status: { type: String, enum: OFFER_STATUSES, default: 'draft' },
    letterUrl: { type: String, default: '' },
    notes: { type: String, default: '' },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
    decidedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

const Offer = mongoose.model('Offer', offerSchema);
export default Offer;
