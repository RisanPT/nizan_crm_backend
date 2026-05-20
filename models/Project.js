import mongoose from 'mongoose';

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
    targetDepartment: {
      type: String,
      enum: ['sales', 'creative', 'marketing', 'fleet', 'accounts', 'admin', 'it', 'general'],
      default: 'general',
    },
    client: {
      type: String,
      default: '',
    },
    features: {
      type: [String],
      default: [],
    },
    managerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      required: true,
    },
    status: {
      type: String,
      enum: ['planning', 'active', 'on-hold', 'completed', 'cancelled'],
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
    budget: {
      type: Number,
      default: 0,
    },
    estimatedValue: {
      type: Number,
      default: 0,
    },
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
  },
  {
    timestamps: true,
  }
);

const Project = mongoose.model('Project', projectSchema);

export default Project;
