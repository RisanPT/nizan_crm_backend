import mongoose from 'mongoose';

// The marketing team's LOG — the one record every Marketing screen reads (Team Dashboard, the day's EOD totals, timesheets,
// performance, and — in later phases — Socials, Creative Portfolio, Campaigns, Coordinations, Strategies and the Weekly Report).
// A member logs the work once; nothing is typed a second time. Many entries per member per day, each with a time.
//
// The member's EOD day entry (models/MarketingEod.js `MarketingEodEntry`) is the ROLL-UP of the day's logs, rebuilt by
// services/marketingRollup.js on every save, edit and delete — so the EOD dashboards, targets, missed-EOD list and month close
// keep working unchanged.

export const BRANDS = ['main', 'kerala'];
export const ACTIVITY_STATUSES = ['completed', 'in_progress', 'pending', 'blocked'];
// what kind of work, for the feed icon and the "meetings" count
export const ACTIVITY_KINDS = ['task', 'meeting', 'shoot', 'post', 'campaign', 'strategy', 'other'];

const attachmentSchema = new mongoose.Schema({ label: { type: String, default: '', trim: true }, url: { type: String, required: true, trim: true } }, { _id: false });

const valueSchema = new mongoose.Schema(
  {
    metricId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingMetric', required: true },
    value: { type: Number, default: 0, min: 0 },
    // the "details box beside every count" (which reels, which links…)
    details: { type: String, default: '', trim: true },
  },
  { _id: false },
);

const marketingActivitySchema = new mongoose.Schema(
  {
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingTeamMember', required: true },
    roleName: { type: String, default: '' }, // the member's role when it was logged
    entryDate: { type: String, required: true }, // YYYY-MM-DD (IST) — the day it counts for
    loggedAt: { type: Date, default: Date.now },

    brand: { type: String, enum: BRANDS, default: 'main' },
    kind: { type: String, enum: ACTIVITY_KINDS, default: 'task' },

    // What the log form asks
    workedOn: { type: String, required: true, trim: true, maxlength: 300 },
    projectLabel: { type: String, default: '', trim: true, maxlength: 200 }, // the project or client, as typed or picked
    completed: { type: String, default: '', trim: true, maxlength: 1000 },
    pending: { type: String, default: '', trim: true, maxlength: 1000 },
    nextPriority: { type: String, default: '', trim: true, maxlength: 500 },
    timeSpentMinutes: { type: Number, default: 0, min: 0, max: 1440 },
    status: { type: String, enum: ACTIVITY_STATUSES, default: 'completed' },
    comment: { type: String, default: '', trim: true, maxlength: 1000 },
    attachments: { type: [attachmentSchema], default: [] },
    values: { type: [valueSchema], default: [] },

    // The activity group it counts under (for workload / category charts): the group of its biggest count, else chosen.
    groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingGroup', default: null },

    // Optional links — the shared keys that let other screens find this log
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', default: null },
    taskId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingTask', default: null },
    campaignId: { type: mongoose.Schema.Types.ObjectId, default: null },
    shootId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingShoot', default: null },
    // which part of the shoot the work was: moves the shoot's milestones (Creative Portfolio)
    shootStage: { type: String, enum: ['pre_production', 'production', 'post_production', null], default: null },
    // the Socials post (ContentItem) the work published: a completed log marks that post published (controllers/marketingTeamController.js
    // syncContent), so a reel / story / post is logged once and the Socials tracker, the Team Dashboard and the Weekly Report all see it
    contentId: { type: mongoose.Schema.Types.ObjectId, ref: 'ContentItem', default: null },
    // what that post was before this log published it, so deleting the log (or moving it off the post) puts the post back
    contentBefore: {
      type: new mongoose.Schema({ status: { type: String, default: null }, publishedDate: { type: Date, default: null }, publishedAt: { type: Date, default: null } }, { _id: false }),
      default: null,
    },
    initiativeId: { type: mongoose.Schema.Types.ObjectId, default: null },
    // the development project the work was for (Strategies & Developments): its logged hours and strategy counts come from these
    devProjectId: { type: mongoose.Schema.Types.ObjectId, ref: 'DevProject', default: null },

    // An earlier whole-day EOD entry, kept as a log when the day first gets a log (so nothing already typed is lost).
    legacy: { type: Boolean, default: false },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    lastEditedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    lastEditedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

marketingActivitySchema.index({ memberId: 1, entryDate: 1 });
marketingActivitySchema.index({ entryDate: 1, brand: 1 });
marketingActivitySchema.index({ taskId: 1 });
marketingActivitySchema.index({ contentId: 1 });
marketingActivitySchema.index({ initiativeId: 1 });
marketingActivitySchema.index({ devProjectId: 1 });

export default mongoose.model('MarketingActivity', marketingActivitySchema);
