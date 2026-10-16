import mongoose from 'mongoose';

export const JOBPOST_STATUSES = ['open', 'on_hold', 'closed'];

// A hiring requisition / job opening. Candidates apply against it; an accepted
// offer closes the loop by creating an Employee.
const jobPostSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    department: { type: String, default: '' },
    designationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Designation', default: null },
    location: { type: String, default: '' },
    type: { type: String, enum: ['full-time', 'contract', 'intern', 'part-time'], default: 'full-time' },
    openings: { type: Number, default: 1 },
    salaryRange: { type: String, default: '' },
    description: { type: String, default: '' },
    status: { type: String, enum: JOBPOST_STATUSES, default: 'open' },
    metaPostId: { type: String, default: null },
    linkedinPostId: { type: String, default: null },
    sharedToSocialAt: { type: Date, default: null },
    applicationUrl: { type: String, default: '' },
    postedOn: { type: Date, default: Date.now },
    closedOn: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

const JobPost = mongoose.model('JobPost', jobPostSchema);
export default JobPost;
