import mongoose from 'mongoose';

// The work mode a marketing team member sets for a day (Team Dashboard → Attendance): in the Office, On Shoot, or Work From Home.
// HR attendance (models/Attendance.js) has no work-mode field and a member working from home has no office check-in, so the member says
// it here — one record per member per day. It decides the member's state on the attendance board (utils/marketingTeamStats.js
// memberStates: leave first, then this, then shoot logs and attendance) and counts as an attended day in the month's rate.
// A member sets their own (today, or a day inside the log edit window); the Marketing Manager / admin can set anyone's.

export const WORK_MODE_VALUES = ['office', 'on_shoot', 'wfh'];

const marketingWorkModeSchema = new mongoose.Schema(
  {
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingTeamMember', required: true },
    day: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ }, // IST day
    mode: { type: String, enum: WORK_MODE_VALUES, required: true },
    note: { type: String, default: '', trim: true, maxlength: 200 },
    setBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

marketingWorkModeSchema.index({ memberId: 1, day: 1 }, { unique: true });
marketingWorkModeSchema.index({ day: 1 });

export default mongoose.model('MarketingWorkMode', marketingWorkModeSchema);
