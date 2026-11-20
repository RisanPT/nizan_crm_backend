import mongoose from 'mongoose';
import { BRANDS } from './MarketingActivity.js';

// A task or deliverable on the Marketing Team Dashboard → Tasks & Deliverables (list · kanban · calendar). Read by the Team Dashboard
// and — in a later phase — Coordinations. A member's log can be linked to a task (`MarketingActivity.taskId`): logging it completed
// completes the task, so work is logged once.

export const TASK_STATUSES = ['not_started', 'in_progress', 'pending', 'blocked', 'completed'];
export const TASK_PRIORITIES = ['high', 'medium', 'low'];

const commentSchema = new mongoose.Schema(
  {
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    byName: { type: String, default: '' },
    text: { type: String, required: true, trim: true, maxlength: 1000 },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const marketingTaskSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 300 },
    description: { type: String, default: '', trim: true, maxlength: 2000 },
    assigneeId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingTeamMember', required: true },
    brand: { type: String, enum: BRANDS, default: 'main' },
    groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingGroup', default: null }, // the activity group / category
    projectLabel: { type: String, default: '', trim: true, maxlength: 200 },
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', default: null },
    isDeliverable: { type: Boolean, default: false },
    // Strategies & Developments: the initiative or development project this task belongs to (their progress is counted from their tasks)
    initiativeId: { type: mongoose.Schema.Types.ObjectId, ref: 'StrategicInitiative', default: null },
    devProjectId: { type: mongoose.Schema.Types.ObjectId, ref: 'DevProject', default: null },

    dueDate: { type: String, default: null }, // YYYY-MM-DD (IST)
    priority: { type: String, enum: TASK_PRIORITIES, default: 'medium' },
    status: { type: String, enum: TASK_STATUSES, default: 'not_started' },
    progress: { type: Number, default: 0, min: 0, max: 100 },
    completedAt: { type: Date, default: null },
    // the log that completed it (deleting that log reopens the task, so every number follows the log)
    completedByActivityId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingActivity', default: null },

    attachments: { type: [{ label: String, url: String, _id: false }], default: [] },
    comments: { type: [commentSchema], default: [] },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    lastEditedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

marketingTaskSchema.index({ assigneeId: 1, status: 1 });
marketingTaskSchema.index({ dueDate: 1 });
marketingTaskSchema.index({ brand: 1, status: 1 });

export default mongoose.model('MarketingTask', marketingTaskSchema);
