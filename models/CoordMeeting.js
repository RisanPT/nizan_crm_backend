import mongoose from 'mongoose';
import { DEPARTMENTS, MEETING_STATUSES } from '../utils/marketingCoordinationStats.js';

// A coordination meeting (Coordinations → Meetings): when, where, the agenda and who attends; afterwards the discussion notes and
// the action items. An action item can become a follow-up (CoordFollowUp) — from then on the follow-up decides whether it is done.

const attendeeSchema = new mongoose.Schema(
  { memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingTeamMember', default: null }, name: { type: String, default: '', trim: true, maxlength: 100 } },
  { _id: false },
);

const actionItemSchema = new mongoose.Schema({
  text: { type: String, required: true, trim: true, maxlength: 300 },
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingTeamMember', default: null },
  ownerName: { type: String, default: '', trim: true, maxlength: 100 },
  due: { type: String, default: null, match: /^\d{4}-\d{2}-\d{2}$/ },
  done: { type: Boolean, default: false },
  followUpId: { type: mongoose.Schema.Types.ObjectId, ref: 'CoordFollowUp', default: null },
});

const coordMeetingSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    location: { type: String, default: '', trim: true, maxlength: 160 },
    link: { type: String, default: '', trim: true, maxlength: 1000 },
    status: { type: String, enum: MEETING_STATUSES, default: 'upcoming' },
    departments: { type: [{ type: String, enum: DEPARTMENTS }], default: [] },
    agenda: { type: [{ type: String, maxlength: 200 }], default: [] },
    attendees: { type: [attendeeSchema], default: [] },
    notes: { type: String, default: '', trim: true, maxlength: 4000 },
    actionItems: { type: [actionItemSchema], default: [] },
    brand: { type: String, enum: ['main', 'kerala'], default: 'main' },
    completedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

coordMeetingSchema.index({ startAt: 1 });
coordMeetingSchema.index({ brand: 1, startAt: 1 });

export default mongoose.model('CoordMeeting', coordMeetingSchema);
