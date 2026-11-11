import mongoose from 'mongoose';
import { REQUEST_STATUSES, LINE_TYPES, LINE_STATES, URGENCIES } from '../utils/manpower.js';

// A project asks for more people; HR covers each seat — with someone on staff (their head releases them when they are not
// already on the project), a new hire (a hiring plan is raised) or a contractor — or declines. See utils/manpower.js.

// One way a seat (or several seats) is covered.
const lineSchema = mongoose.Schema({
  type: { type: String, enum: LINE_TYPES, required: true },
  state: { type: String, enum: LINE_STATES, default: 'assigned' },
  seats: { type: Number, default: 1, min: 1 },
  // for a hire: how many of its seats have a person allocated so far (an internal or contract line is filled at once)
  filled: { type: Number, default: 0, min: 0 },
  // internal: the person, and how much of their time, and when
  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
  employeeName: { type: String, default: '' },
  employeeDept: { type: String, default: '' },
  percent: { type: Number, default: 0 },
  from: { type: Date, default: null },
  to: { type: Date, default: null },
  // the head who has to let the person go (an Employee), and what they answered
  releaseHeadEmp: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
  releasedAt: { type: Date, default: null },
  releaseNote: { type: String, default: '' },
  // hire: the hiring plan raised for it
  hiringPlanId: { type: mongoose.Schema.Types.ObjectId, ref: 'HiringPlan', default: null },
  // contract: who
  vendorName: { type: String, default: '' },
  // what it costs the project (a hire, a contractor); people already on staff cost nothing extra
  cost: { type: Number, default: 0, min: 0 },
  note: { type: String, default: '' },
  addedByName: { type: String, default: '' },
});

const manpowerRequestSchema = mongoose.Schema(
  {
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    projectName: { type: String, default: '' },
    // the project's owning department, and its manager, when the request was made
    department: { type: String, default: '' },
    managerEmp: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    requestedByName: { type: String, default: '' },
    roleTitle: { type: String, required: true, trim: true },
    skills: { type: String, default: '' },
    headcount: { type: Number, default: 1, min: 1 },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    // how much of each person's time (percent)
    allocationPercent: { type: Number, default: 100, min: 1, max: 100 },
    urgency: { type: String, enum: URGENCIES, default: 'normal' },
    reason: { type: String, default: '' },
    estimatedCost: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: REQUEST_STATUSES, default: 'submitted', index: true },
    lines: { type: [lineSchema], default: [] },
    hrOwner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    hrOwnerName: { type: String, default: '' },
    decisionNote: { type: String, default: '' },
    decidedAt: { type: Date, default: null },
    decidedByName: { type: String, default: '' },
  },
  { timestamps: true },
);

manpowerRequestSchema.index({ status: 1, createdAt: -1 });
manpowerRequestSchema.index({ 'lines.releaseHeadEmp': 1, status: 1 });

const ManpowerRequest = mongoose.model('ManpowerRequest', manpowerRequestSchema);
export default ManpowerRequest;
