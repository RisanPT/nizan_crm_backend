import mongoose from 'mongoose';

// A review (Strategies & Developments → Reviews): how a strategy, project, campaign or quarter went. The outcomes are the team's list of
// what it set out to do and how each ended; the score (Achieved / Partially / Not achieved) is COUNTED from them, never typed
// (utils/marketingStrategyStats.js `reviewScores`). Action items are the next steps, each with an owner, a priority and a target day.
export const REVIEW_TYPES = ['strategy', 'project', 'campaign', 'quarterly'];
export const OUTCOME_STATES = ['achieved', 'partial', 'missed'];
export const ACTION_STATUSES = ['open', 'in_progress', 'done'];
export const ACTION_PRIORITIES = ['high', 'medium', 'low'];
// what a review can be about: a strategic plan, a development project or an initiative (shown with its CURRENT progress and status)
export const REVIEW_LINK_KINDS = ['plan', 'project', 'initiative'];

const outcomeSchema = new mongoose.Schema(
  { text: { type: String, required: true, trim: true, maxlength: 300 }, state: { type: String, enum: OUTCOME_STATES, default: 'achieved' } },
  { _id: false },
);

const actionSchema = new mongoose.Schema({
  text: { type: String, required: true, trim: true, maxlength: 300 },
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingTeamMember', default: null },
  priority: { type: String, enum: ACTION_PRIORITIES, default: 'medium' },
  targetDate: { type: String, default: null, match: /^\d{4}-\d{2}-\d{2}$/ },
  status: { type: String, enum: ACTION_STATUSES, default: 'open' },
});

const strategyReviewSchema = new mongoose.Schema(
  {
    type: { type: String, enum: REVIEW_TYPES, required: true },
    periodLabel: { type: String, required: true, trim: true, maxlength: 60 }, // "Q3 2026", "Website v2 launch"
    reviewDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ }, // the day it was held (IST), what the date range filters on
    brand: { type: String, enum: ['main', 'kerala'], default: 'main' },
    summary: { type: String, default: '', trim: true, maxlength: 2000 },
    outcomes: { type: [outcomeSchema], default: [] },
    actionItems: { type: [actionSchema], default: [] },
    // optional: the plan / development project / initiative this review is about
    linkKind: { type: String, enum: [...REVIEW_LINK_KINDS, null], default: null },
    linkId: { type: mongoose.Schema.Types.ObjectId, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdByName: { type: String, default: '' },
    lastEditedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

strategyReviewSchema.index({ reviewDate: 1, brand: 1 });
strategyReviewSchema.index({ type: 1 });

export default mongoose.model('StrategyReview', strategyReviewSchema);
