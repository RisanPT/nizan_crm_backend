import mongoose from 'mongoose';

export const CANDIDATE_STAGES = ['applied', 'screening', 'interview', 'offer', 'hired', 'rejected'];

export const CANDIDATE_SOURCES = [
  'website',
  'referral',
  'job_portal',
  'agency',
  'walk-in',
  'social',
  'linkedin',
  'meta',
  'instagram',
  'facebook',
  'campus',
  'other',
];

// An applicant in the recruitment pipeline (the CV bank). Moves through stages;
// reaching "offer" is where an Offer is raised, and "hired" when accepted.
const candidateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, default: '' },
    phone: { type: String, default: '' },
    jobPostId: { type: mongoose.Schema.Types.ObjectId, ref: 'JobPost', default: null },
    jobTitle: { type: String, default: '' },
    source: { type: String, enum: CANDIDATE_SOURCES, default: 'website' },
    referrer: { type: String, default: '' },
    stage: { type: String, enum: CANDIDATE_STAGES, default: 'applied' },
    rating: { type: Number, default: 0 }, // 0..5
    resumeUrl: { type: String, default: '' },
    notes: { type: String, default: '' },
    appliedOn: { type: Date, default: Date.now },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

candidateSchema.index({ jobPostId: 1, stage: 1 });

const Candidate = mongoose.model('Candidate', candidateSchema);
export default Candidate;
