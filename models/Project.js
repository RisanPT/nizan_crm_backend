import mongoose from 'mongoose';

// One department on a project. The project has exactly one `owner` (the department
// accountable for it, approving it); the rest are `participant`s the project manager
// invites. A participant's head must accept before its people work on the project.
const projectDepartmentSchema = mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    role: { type: String, enum: ['owner', 'participant'], default: 'participant' },
    // The person coordinating the project for that department (default: its head).
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
    status: { type: String, enum: ['invited', 'accepted', 'declined'], default: 'invited' },
    invitedAt: { type: Date, default: null },
    respondedAt: { type: Date, default: null },
    respondedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // When the manager last nudged the head about an unanswered invitation (throttled, see utils/projectActivity.js).
    remindedAt: { type: Date, default: null },
  },
  { _id: false },
);

// What happened to the project that nothing else records: a change of status, a decision on a
// proposal, a reminder. The rest of the activity feed is worked out from the project's own timestamps.
const projectActivitySchema = mongoose.Schema(
  {
    kind: { type: String, default: 'note' },
    text: { type: String, required: true },
    byName: { type: String, default: '' },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

// One line of the cost breakdown.
const costLineSchema = mongoose.Schema(
  {
    category: { type: String, default: 'other' },
    amount: { type: Number, default: 0 },
    note: { type: String, default: '' },
  },
  { _id: false },
);

// A change to the cost after it was approved: when, by whom, why, and what moved.
const costChangeSchema = mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    byName: { type: String, default: '' },
    reason: { type: String, default: '' },
    lines: { type: [String], default: [] },
  },
  { _id: false },
);

const projectSchema = mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Please add a project name'],
    },
    description: {
      type: String,
      default: '',
    },
    type: {
      type: String,
      enum: ['internal', 'client'],
      default: 'internal',
    },
    // Owning department (a Department name, e.g. 'IT', 'Sales'). Drives the
    // company-wide, department-scoped Projects/Planning visibility. Open string
    // so any admin-created department works.
    targetDepartment: {
      type: String,
      default: '',
      trim: true,
    },
    // The departments the project involves (owner first). `targetDepartment` above
    // is kept equal to the owner so everything written before this keeps working;
    // a project saved before departments existed has none stored here and its
    // `targetDepartment` stands in (see utils/projectDepartments.js).
    departments: {
      type: [projectDepartmentSchema],
      default: [],
    },
    activity: {
      type: [projectActivitySchema],
      default: [],
    },
    // Who may change tasks: 'managed' = the project manager (and a department's lead
    // for its own tasks) decide the plan, people update only their own tasks;
    // 'open' = anyone on the project edits anything. UNSET = open, so projects from
    // before this setting behave exactly as they did.
    editMode: {
      type: String,
      enum: ['managed', 'open'],
    },
    // A staff member's proposal waits (status 'proposed') for the owning department's
    // head or an admin to approve it.
    proposedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, default: '' },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    client: {
      type: String,
      default: '',
    },
    features: {
      type: [String],
      default: [],
    },
    // Multi-Year Strategic Horizon Planning:
    // Dynamic Horizon Wave (H1, H2, H3, H4, etc.)
    horizonNumber: {
      type: Number,
      min: 1,
      default: 1,
    },
    strategicPillar: {
      type: String,
      default: '',
      trim: true,
    },
    targetYear: {
      type: Number,
      default: null,
    },
    managerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      required: true,
    },
    members: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Employee',
      },
    ],
    status: {
      type: String,
      enum: ['proposed', 'planning', 'active', 'on-hold', 'completed', 'cancelled'],
      default: 'planning',
    },
    priority: {
      type: String,
      enum: ['low', 'medium', 'high', 'critical'],
      default: 'medium',
    },
    startDate: {
      type: Date,
      default: Date.now,
    },
    endDate: {
      type: Date,
    },
    tags: {
      type: [String],
      default: [],
    },
    // The estimated cost asked for when the project was added (what the breakdown below adds up to, when there is one).
    budget: {
      type: Number,
      default: 0,
    },
    estimatedValue: {
      type: Number,
      default: 0,
    },
    // The cost breakdown (optional), the finance head's decision on it, and the changes after (see utils/projectCost.js).
    costPlan: { type: [costLineSchema], default: [] },
    // none = a project from before costs existed · pending = with the finance head · approved · returned = sent back
    costStatus: { type: String, enum: ['none', 'pending', 'approved', 'returned'], default: 'none' },
    // What the finance head approved — the limit spending is held against. 0 until approved.
    approvedBudget: { type: Number, default: 0 },
    costRequestedAt: { type: Date, default: null },
    costDecidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    costDecidedAt: { type: Date, default: null },
    costDecidedByName: { type: String, default: '' },
    // How far the spending has got along the approved limit when the people running the project were last told: ok | warn | over.
    costAlertLevel: { type: String, default: 'ok' },
    costDecisionNote: { type: String, default: '' },
    costChanges: { type: [costChangeSchema], default: [] },
    progress: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    phase: {
      type: String,
      enum: ['discovery', 'design', 'development', 'testing', 'deployment', 'maintenance'],
      default: 'discovery',
    },
    category: {
      type: String,
      enum: ['Software', 'Infrastructure', 'Security', 'Support', 'General'],
      default: 'Software',
    },
    targetReleaseDate: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

const Project = mongoose.model('Project', projectSchema);

export default Project;
