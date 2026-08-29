import mongoose from 'mongoose';

// One entry in a ticket's activity thread (comment / status change / assignment).
const activitySchema = mongoose.Schema(
  {
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    byName: { type: String, default: '' },
    kind: { type: String, enum: ['created', 'comment', 'status', 'assign'], default: 'comment' },
    text: { type: String, default: '' },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

// An internal support ticket — any department raises bug / feature / support
// requests; the IT department triages and resolves.
const ticketSchema = mongoose.Schema(
  {
    ticketNumber: { type: String, unique: true, sparse: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    type: { type: String, enum: ['bug', 'feature', 'support'], default: 'bug' },
    priority: { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'medium' },
    status: { type: String, enum: ['open', 'in-progress', 'resolved', 'closed', 'rejected'], default: 'open' },
    module: { type: String, default: '' }, // which screen / area

    raisedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    raisedByName: { type: String, default: '' },
    // The raiser's department — drives "whole department + IT" visibility.
    departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', default: null },

    // Refs Employee (like Project.managerId / ITTask.assignedTo); the linked
    // login User is resolved via getUserIdsByEmployeeIds for notifications.
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
    assignedToName: { type: String, default: '' },

    screenshots: { type: [String], default: [] },
    activity: { type: [activitySchema], default: [] },

    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    resolvedAt: { type: Date, default: null },
    resolution: { type: String, default: '' },

    // Set when a ticket is promoted into an IT task (phase 4).
    linkedTaskId: { type: mongoose.Schema.Types.ObjectId, ref: 'ITTask', default: null },
  },
  { timestamps: true },
);

ticketSchema.pre('validate', function genTicketNumber(next) {
  if (this.ticketNumber) return next();
  const d = this.createdAt || new Date();
  const p = `${String(d.getFullYear()).slice(-2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  this.ticketNumber = `TKT-${p}-${Math.floor(1000 + Math.random() * 9000)}`;
  next();
});

export default mongoose.model('Ticket', ticketSchema);
