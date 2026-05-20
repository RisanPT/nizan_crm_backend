import mongoose from 'mongoose';

const itTaskSchema = mongoose.Schema(
  {
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
    },
    title: {
      type: String,
      required: [true, 'Please add a task title'],
    },
    description: {
      type: String,
      default: '',
    },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      required: true,
    },
    status: {
      type: String,
      enum: ['todo', 'in-progress', 'review', 'completed'],
      default: 'todo',
    },
    priority: {
      type: String,
      enum: ['low', 'medium', 'high', 'critical'],
      default: 'medium',
    },
    deadline: {
      type: Date,
    },
    estimatedHours: {
      type: Number,
      default: 0,
    },
    actualHours: {
      type: Number,
      default: 0,
    },
    category: {
      type: String,
      enum: ['feature', 'bug', 'maintenance', 'research'],
      default: 'feature',
    },
    estimatedValue: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

const ITTask = mongoose.model('ITTask', itTaskSchema);

export default ITTask;
