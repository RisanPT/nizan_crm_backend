import mongoose from 'mongoose';

// One report on a key result — what it stood at, and who said so. Written by the
// server on every check-in (the app never sends these), so the timeline can plot them.
const checkInSchema = mongoose.Schema(
  {
    value: { type: Number, default: 0 },
    completed: { type: Boolean, default: false },
    at: { type: Date, default: Date.now },
    by: { type: String, default: '' },
  },
  { _id: false },
);

const keyResultItemSchema = mongoose.Schema(
  {
    id: { type: String, default: () => new mongoose.Types.ObjectId().toString() },
    title: { type: String, required: true },
    metric: { type: String, default: '' },
    targetValue: { type: Number, default: 100 },
    currentValue: { type: Number, default: 0 },
    unit: { type: String, default: '%' },
    completed: { type: Boolean, default: false },
    checkIns: { type: [checkInSchema], default: [] },
  },
  { _id: false },
);

const documentItemSchema = mongoose.Schema(
  {
    name: { type: String, required: true },
    url: { type: String, required: true },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const okrSchema = mongoose.Schema(
  {
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Project',
      default: null,
    },
    department: {
      type: String,
      default: 'research-and-development',
    },
    // company | department | project. Stored explicitly: it used to be guessed from
    // the department text ('research-and-development' or blank meant company-wide),
    // which meant a real R&D department could never have objectives of its own.
    // Documents saved before this have none and are read the old way
    // (see levelOf in utils/okrAccess.js).
    level: {
      type: String,
      enum: ['company', 'department', 'project'],
    },
    objective: {
      type: String,
      required: [true, 'Please add an objective title'],
      trim: true,
    },
    description: {
      type: String,
      default: '',
    },
    projectHeadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      default: null,
    },
    projectHeadName: {
      type: String,
      default: '',
    },
    startDate: {
      type: Date,
      default: null,
    },
    deadline: {
      type: Date,
      default: null,
    },
    status: {
      type: String,
      enum: ['not-started', 'in-progress', 'completed', 'blocked'],
      default: 'in-progress',
    },
    priority: {
      type: String,
      enum: ['critical', 'high', 'medium', 'low'],
      default: 'high',
    },
    progress: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    keyResults: {
      type: [keyResultItemSchema],
      default: [],
    },
    documents: {
      type: [documentItemSchema],
      default: [],
    },
    parentObjectiveId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'OKR',
      default: null,
    },
    order: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  },
);

const OKR = mongoose.model('OKR', okrSchema);

export default OKR;
