import mongoose from 'mongoose';

const keyResultItemSchema = mongoose.Schema(
  {
    id: { type: String, default: () => new mongoose.Types.ObjectId().toString() },
    title: { type: String, required: true },
    metric: { type: String, default: '' },
    targetValue: { type: Number, default: 100 },
    currentValue: { type: Number, default: 0 },
    unit: { type: String, default: '%' },
    completed: { type: Boolean, default: false },
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
