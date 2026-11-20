import mongoose from 'mongoose';
import { DEPARTMENTS, FOLLOWUP_STATUSES } from '../utils/marketingCoordinationStats.js';

// A follow-up (Coordinations → Follow-ups): something to chase by a day. Its state (upcoming / due today / overdue / completed) is
// derived from the day and `status`, never typed. With `reminder` on, its owner is told when it falls due (or that it is overdue, when
// first seen late) — ONCE per due day: services/marketingCoordReminders.js stamps `remindedFor` (the due day it reminded for) atomically
// before it sends, from the reminder scheduler and whenever the Follow-ups / Overview are read. Moving the due day arms it again.
// It can come from a meeting's action item (meetingId + meetingItemId).

const coordFollowUpSchema = new mongoose.Schema(
  {
    item: { type: String, required: true, trim: true, maxlength: 300 },
    relatedTo: { type: String, default: '', trim: true, maxlength: 200 },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingTeamMember', default: null },
    ownerName: { type: String, default: '', trim: true, maxlength: 100 },
    department: { type: String, enum: DEPARTMENTS, default: 'Marketing' },
    dueDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ }, // IST day
    status: { type: String, enum: FOLLOWUP_STATUSES, default: 'open' },
    doneAt: { type: Date, default: null },
    reminder: { type: Boolean, default: false },
    remindedFor: { type: String, default: null }, // the due day a reminder was sent for (one per due day)
    remindedAt: { type: Date, default: null },
    meetingId: { type: mongoose.Schema.Types.ObjectId, ref: 'CoordMeeting', default: null },
    meetingItemId: { type: mongoose.Schema.Types.ObjectId, default: null },
    brand: { type: String, enum: ['main', 'kerala'], default: 'main' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

coordFollowUpSchema.index({ dueDate: 1, status: 1 });
coordFollowUpSchema.index({ meetingId: 1 });

export default mongoose.model('CoordFollowUp', coordFollowUpSchema);
