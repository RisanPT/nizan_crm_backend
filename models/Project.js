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
    // Owning department (a Department name, e.g. 'IT', 'Sales'). Drives the
    // company-wide, department-scoped Projects/Planning visibility. Open string
    // so any admin-created department works.
    targetDepartment: {
      type: String,
      default: '',
      trim: true,
    },
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
