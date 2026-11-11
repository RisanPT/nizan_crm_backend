import mongoose from 'mongoose';

// Who is on a project, for how much of their time and when — made when HR covers a seat of a manpower request with a person
// (their head has released them if they were needed from outside the project's departments).
const projectAllocationSchema = mongoose.Schema(
  {
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    employeeName: { type: String, default: '' },
    role: { type: String, default: '' },
    percent: { type: Number, default: 100, min: 1, max: 100 },
    from: { type: Date, required: true },
    to: { type: Date, required: true },
    requestId: { type: mongoose.Schema.Types.ObjectId, ref: 'ManpowerRequest', default: null },
    lineId: { type: mongoose.Schema.Types.ObjectId, default: null },
    // 'ended' only when someone ends it early; one whose last day has passed is "ended" by its date
    status: { type: String, enum: ['active', 'ended'], default: 'active' },
    createdByName: { type: String, default: '' },
  },
  { timestamps: true },
);

projectAllocationSchema.index({ employeeId: 1, from: 1, to: 1 });

const ProjectAllocation = mongoose.model('ProjectAllocation', projectAllocationSchema);
export default ProjectAllocation;
