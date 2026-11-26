import asyncHandler from 'express-async-handler';
import ContentItem from '../models/ContentItem.js';
import MarketingAsset from '../models/MarketingAsset.js';
import MarketingShoot from '../models/MarketingShoot.js';
import MarketingTask from '../models/MarketingTask.js';
import ResearchFinding from '../models/ResearchFinding.js';
import StrategyReview from '../models/StrategyReview.js';
import { MarketingTeamMember } from '../models/MarketingEod.js';
import { toDateStr, canViewTeam, canManageCreative, isCreativeDirector } from './marketingEodController.js';
import { isDay } from '../utils/marketingActivityInput.js';
import * as T from '../utils/marketingTeamStats.js';
import * as C from '../utils/creativeDashboard.js';

// The Creative Director dashboard — GET /api/creative/overview?from&to&brand (this week, all brands by default).
// Read by the Creative Director (User.creativeDirector), Marketing managers and admins, and leadership (read-only through the CEO guard).
// Every figure is defined in utils/creativeDashboard.js; this file only loads the records.

const IST = 5.5 * 60 * 60 * 1000;
const istStart = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - IST);
const istEnd = (day) => istStart(T.addDays(day, 1));
const idOf = (v) => (v == null ? '' : String(v._id ?? v));
const minDay = (...d) => d.filter(Boolean).sort()[0];
const maxDay = (...d) => d.filter(Boolean).sort().at(-1);

const bad = (res, message, status = 400) => {
  res.status(status);
  throw new Error(message);
};

/** Who may open the dashboard: the Creative Director, Marketing managers / admins, and management (read-only). */
export const canViewCreative = (user) => isCreativeDirector(user) || canViewTeam(user);

const readRange = (req, res) => {
  const today = toDateStr();
  const week = C.weekOf(today);
  const from = req.query.from ?? week.from;
  const to = req.query.to ?? week.to;
  if (!isDay(from) || !isDay(to)) bad(res, 'The dates must be YYYY-MM-DD.');
  if (to < from) bad(res, 'The end date is before the start date.');
  if (T.daysBetween(from, to) > 366) bad(res, 'Choose a range of a year or less.');
  const brand = String(req.query.brand ?? 'all').toLowerCase();
  if (!['all', 'main', 'kerala'].includes(brand)) bad(res, 'Choose All, Main or Kerala.');
  return { from, to, brand, today };
};

const SHOOT_FIELDS = 'title brand category status shootDate coverUrl references milestones createdAt';
const ASSET_FIELDS = 'title brand stage kind thumbUrl shootId approvedAt isFinal createdAt updatedAt';
const POST_FIELDS = 'title platform contentType status brand scheduledDate publishedDate thumbUrl permalink metrics createdAt updatedAt';

export const getOverview = asyncHandler(async (req, res) => {
  if (!canViewCreative(req.user)) bad(res, 'Only the Creative Director, the Marketing Manager or management can open this dashboard.', 403);
  const range = readRange(req, res);
  const prev = T.previousRange(range);
  // the calendar shows this week while the range holds today, else the range's last week
  const week = C.weekOf(range.today >= range.from && range.today <= range.to ? range.today : range.to);
  // the month card: the month the range ends in (or this month, while the range reaches today), against the month before
  const monthDay = range.today >= range.from && range.today <= range.to ? range.today : range.to;
  const month = C.monthOf(monthDay);
  const monthBefore = C.monthOf(T.addDays(month.from, -1));
  const first = minDay(prev.from, monthBefore.from, week.from);
  const last = maxDay(range.to, week.to, month.to);
  const a = istStart(first);
  const z = istEnd(last);

  const [items, inReviewPosts, shoots, assets, findings, reviews, tasks] = await Promise.all([
    ContentItem.find({ $or: [{ scheduledDate: { $gte: a, $lt: z } }, { publishedDate: { $gte: a, $lt: z } }] }).select(POST_FIELDS).limit(10000).lean(),
    ContentItem.find({ status: 'in-review' }).select(POST_FIELDS).limit(500).lean(),
    MarketingShoot.find({
      status: { $ne: 'cancelled' },
      $or: [{ status: { $in: [...C.OPEN_SHOOT] } }, { createdAt: { $gte: a } }, { 'milestones.doneAt': { $gte: a } }],
    })
      .select(SHOOT_FIELDS)
      .limit(2000)
      .lean(),
    MarketingAsset.find({ $or: [{ approvedAt: { $gte: a } }, { stage: { $in: ['in_review', 'in_edit', 'post_produced'] } }] }).select(ASSET_FIELDS).limit(5000).lean(),
    ResearchFinding.find({ date: { $gte: range.from, $lte: range.to } }).select('brand date').lean(),
    StrategyReview.find({ reviewDate: { $gte: range.from, $lte: range.to } }).select('brand reviewDate actionItems.status').lean(),
    MarketingTask.find({ status: { $ne: 'completed' } }).select('title assigneeId status priority dueDate brand').sort({ dueDate: 1 }).limit(1000).lean(),
  ]);

  const shootTitles = new Map(shoots.map((s) => [idOf(s), s.title]));
  const missing = [...new Set(assets.filter((x) => x.stage === 'in_review' && x.shootId && !shootTitles.has(idOf(x.shootId))).map((x) => idOf(x.shootId)))];
  if (missing.length) for (const s of await MarketingShoot.find({ _id: { $in: missing } }).select('title').lean()) shootTitles.set(idOf(s), s.title);
  const members = await MarketingTeamMember.find({ _id: { $in: [...new Set(tasks.map((t) => idOf(t.assigneeId)).filter(Boolean))] } }).select('name').lean();
  const names = new Map(members.map((m) => [idOf(m), m.name]));

  const pending = C.approvals({ assets, posts: inReviewPosts, shootTitles }, range);
  const data = { shoots, items, assets };
  res.json({
    from: range.from,
    to: range.to,
    brand: range.brand,
    today: range.today,
    canManage: canManageCreative(req.user),
    kpis: C.kpis(data, range),
    workflow: C.workflow({ ...data, findings, reviews, approvalsTotal: pending.total }, range),
    projects: C.activeProjects(shoots, range),
    calendar: { from: week.from, to: week.to, days: C.calendarWeek(items, week, range.brand) },
    performance: C.performance(items, range),
    top: C.topContent(items, range),
    tasks: C.openTasks(tasks, names, range),
    approvals: pending,
    month: C.monthOverview(data, monthDay, range.brand),
  });
});
