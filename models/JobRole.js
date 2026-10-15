import mongoose from 'mongoose';

// Organizational Role & Job Analysis Rubric.
// Captures 5-tier organizational hierarchy (T1 Board -> T2 CEO -> T3 C-Suite -> T4 Heads -> T5 Teams),
// reporting line linkages, job charter (purpose, responsibilities, deliverables),
// and job analysis specifications (experience, qualifications, skill matrix, assessment competencies).
const jobRoleSchema = new mongoose.Schema(
  {
    roleCode: { type: String, trim: true, default: '' },
    designation: { type: String, required: true, trim: true },
    shortTitle: { type: String, trim: true, default: '' },
    dept: { type: String, required: true, trim: true },
    band: { type: String, enum: ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'], default: 'L3' },
    tier: { type: Number, min: 1, max: 5, default: 5 },
    parentId: { type: String, default: null }, // ID or code of parent role in hierarchy
    reportsTo: { type: String, default: '' }, // Display name of parent role / reporting manager
    team: { type: String, default: '' },
    headcount: { type: Number, default: 1 },
    purpose: { type: String, default: '' },
    responsibilities: [{ type: String }],
    deliverables: { type: String, default: '' },
    exp: { type: String, default: '2-4 yrs' },
    qual: { type: String, default: '' },
    skills: [
      {
        name: { type: String, required: true },
        score: { type: Number, default: 4.5 },
      },
    ],
    competencies: [{ type: String }],
    active: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

const JobRole = mongoose.model('JobRole', jobRoleSchema);
export default JobRole;
