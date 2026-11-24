import mongoose from 'mongoose';

// The mark a source item (an expense, a payout, a hiring plan, a project's cost) carries while it waits for the CEO / Executive Director:
// `awaiting` — the team has checked it and it is held; `approved` / `rejected` — a leader decided. A missing stamp means "none". The
// DecisionRequest is the authority; this is a cache so the source's own screens (and the team's inbox) can say "With CEO / ED" without a lookup.
export const LEADERSHIP_STATES = ['none', 'awaiting', 'approved', 'rejected'];

export const leadershipStampSchema = new mongoose.Schema(
  {
    state: { type: String, enum: LEADERSHIP_STATES, default: 'none' },
    requestId: { type: mongoose.Schema.Types.ObjectId, ref: 'DecisionRequest', default: null },
    amount: { type: Number, default: null }, // what was held (a budget: the amount the finance head proposed)
    checkedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    checkedByName: { type: String, default: '' },
    checkedAt: { type: Date, default: null },
  },
  { _id: false },
);

export const leadershipStampField = () => ({ type: leadershipStampSchema, default: () => ({}) });
