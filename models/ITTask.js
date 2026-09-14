import mongoose from 'mongoose';

const itTaskSchema = mongoose.Schema(
  {
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
    },
    // WBS hierarchy: null = a top-level row (a phase). A phase is simply a task
    // with children; WBS depth is unlimited via this self-reference.
    parentTaskId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ITTask',
      default: null,
    },
    title: {
      type: String,
      required: [true, 'Please add a task title'],
    },
    description: {
      type: String,
      default: '',
    },
    // Optional: phase / summary rows have no owner (matches the WBS template).
    // Leaf tasks are still given an assignee by the editor form.
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      default: null,
    },
    status: {
      type: String,
      enum: [
        'backlog',
        'todo',
        'in-progress',
        'code-review',
        'qa-testing',
        'deployed',
        'closed',
        'review',
        'completed',
      ],
      default: 'todo',
    },
    priority: {
      type: String,
      default: 'medium',
    },
    severity: {
      type: String,
      enum: ['p0', 'p1', 'p2', 'p3', 'critical', 'high', 'medium', 'low'],
      default: 'p2',
    },
    ticketType: {
      type: String,
      enum: ['feature', 'bug', 'tech-debt', 'infrastructure', 'maintenance', 'research'],
      default: 'feature',
    },
    subTeam: {
      type: String,
      enum: ['frontend', 'backend', 'devops', 'qa', 'general'],
      default: 'general',
    },
    predecessorIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ITTask',
      },
    ],
    subtasks: [
      {
        id: { type: String, default: () => new mongoose.Types.ObjectId().toString() },
        title: { type: String, default: '' },
        completed: { type: Boolean, default: false },
      },
    ],
    activityLogs: [
      {
        message: { type: String, required: true },
        author: { type: String, default: 'Team Member' },
        type: { type: String, default: 'note' },
        timestamp: { type: Date, default: Date.now },
      },
    ],
    // Gantt bar start; `deadline` is the bar's end.
    startDate: {
      type: Date,
    },
    deadline: {
      type: Date,
    },
    // Per-task completion for the WBS "% of task complete" column (0–100).
    // Kept in sync with `status` by updateITTask.
    percentComplete: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    // Sort index among siblings, for stable WBS numbering (1, 1.1, 1.2 …).
    order: {
      type: Number,
      default: 0,
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
      default: 'feature',
    },
    estimatedValue: {
      type: Number,
      default: 0,
    },
    // Set when the task is moved to 'completed' (updateITTask writes it; without
    // this field Mongoose strict mode silently discarded the completion time).
    completedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

const ITTask = mongoose.model('ITTask', itTaskSchema);

export default ITTask;
