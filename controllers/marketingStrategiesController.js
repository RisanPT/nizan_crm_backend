import asyncHandler from 'express-async-handler';
import mongoose from 'mongoose';
import StrategicInitiative from '../models/StrategicInitiative.js';
import DevProject from '../models/DevProject.js';
import StrategicPlan from '../models/StrategicPlan.js';
import RoadmapItem from '../models/RoadmapItem.js';
import ResearchFinding from '../models/ResearchFinding.js';
import StrategyReview from '../models/StrategyReview.js';
import MarketingTask from '../models/MarketingTask.js';
import MarketingActivity from '../models/MarketingActivity.js';
import Lead from '../models/Lead.js';
import { MarketingTeamMember, MarketingGroup, MarketingMetric } from '../models/MarketingEod.js';
import { toDateStr, isManagerOrAdmin, findOwnMember } from './marketingEodController.js';
import { leadScopeFor, withBrands, LEAD_CAP } from '../services/marketingLeadReportData.js';
import { STRATEGY_GROUP } from '../utils/seedMarketingMaster.js';
import {
  cleanRangeQuery, cleanYear, cleanInitiativeInput, cleanProjectInput, cleanPlanInput, cleanRoadmapInput, cleanFindingInput, cleanReviewInput,
  cleanActionStatus, cleanTick, cleanPaging,
} from '../utils/marketingStrategyInput.js';
import * as S from '../utils/marketingStrategyStats.js';
import * as T from '../utils/marketingTeamStats.js';

// Strategies & Developments — Overview, Strategic Plans, Development Projects, Roadmap, Initiatives, Research & Insights, Reviews (the marketing
// team's document, pages 19–20). Routes: routes/marketingStrategiesRoutes.js, /api/marketing/strategies.
//
// Nothing here is typed twice: an initiative's or a project's progress, owner (when not chosen), due day (when not typed) and status are
// COUNTED from the tasks tied to it, its hours from the logs tied to it (Log Activity); a plan's score is its status; a review's score is
// counted from its outcomes. Every number is defined in utils/marketingStrategyStats.js — this file only loads the records and calls it.
//
// Who may do what (the route file's gate lets Marketing roles in; the CEO / Executive Director read through the leadership guard):
//   read everything ........ every Marketing user
//   managers / admin ....... create, edit and delete plans, projects, roadmap lines and reviews; set a status; delete initiatives / findings
//   team members ........... create initiatives; update the initiatives (and projects) they OWN (not the status or the owner); tick roadmap
//                            lines; add findings and edit / delete their own; tick their own review action items

const IST = 5.5 * 60 * 60 * 1000;
const istStart = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - IST);
const istEnd = (day) => istStart(T.addDays(day, 1));
const idOf = (v) => (v == null ? '' : String(v._id ?? v));
const bad = (res, message, status = 400) => {
  res.status(status);
  throw new Error(message);
};
const brandQ = (brand) => (brand === 'all' ? {} : { brand });
const TASK_FIELDS = 'title assigneeId dueDate status progress completedAt initiativeId devProjectId';

const readRange = (req, res) => {
  const today = toDateStr();
  const r = cleanRangeQuery(req.query, today);
  if (!r.ok) bad(res, r.message);
  return { ...r.value, today };
};

/** The viewer: manager or not, and their own team-member record (null when not on the team). */
const viewer = async (req) => ({ manager: isManagerOrAdmin(req.user), own: await findOwnMember(req.user) });
const needManager = (v, res, message) => {
  if (!v.manager) bad(res, message, 403);
};
/** Writes by a team member need a team-member record (a manager / admin may write without one). */
const needTeam = (v, res) => {
  if (!v.manager && !v.own) bad(res, 'You are not on the Marketing team.', 403);
};
const validId = (res, id, what) => {
  if (!mongoose.isValidObjectId(id)) bad(res, `That ${what} was not found.`, 404);
};

const loadNames = async (ids) => {
  const uniq = [...new Set(ids.filter(Boolean).map(String))].filter((i) => mongoose.isValidObjectId(i));
  const rows = uniq.length ? await MarketingTeamMember.find({ _id: { $in: uniq } }).select('name').lean() : [];
  return new Map(rows.map((m) => [idOf(m), m.name]));
};
const loadPlans = async () => new Map((await StrategicPlan.find({}).limit(500).lean()).map((p) => [idOf(p), p]));

/** Map<metricId, name> of the Strategies log types (the EOD Strategies area — utils/seedMarketingMaster.js). */
const strategyMetricNames = async () => {
  const group = await MarketingGroup.findOne({ name: STRATEGY_GROUP }).select('_id').lean();
  if (!group) return new Map();
  return new Map((await MarketingMetric.find({ groupId: group._id }).select('name').lean()).map((m) => [idOf(m), m.name]));
};

/**
 * What the logs tied to these initiatives / projects add up to (all time): minutes, and the Strategies log types counted
 * (utils/marketingStrategyStats.js strategyLogCounts). → { minutes: Map<'initiative:id' | 'project:id', minutes>, strategy: Map<same key, …> }
 */
const logFiguresFor = async (initiativeIds = [], projectIds = []) => {
  if (!initiativeIds.length && !projectIds.length) return { minutes: new Map(), strategy: new Map() };
  const [logs, names] = await Promise.all([
    MarketingActivity.find({ $or: [...(initiativeIds.length ? [{ initiativeId: { $in: initiativeIds } }] : []), ...(projectIds.length ? [{ devProjectId: { $in: projectIds } }] : [])] })
      .select('initiativeId devProjectId timeSpentMinutes values')
      .limit(50000)
      .lean(),
    strategyMetricNames(),
  ]);
  const strategy = S.strategyLogCounts(logs, (id) => names.get(id));
  const minutes = new Map();
  for (const l of logs) {
    if (l.initiativeId) minutes.set(`initiative:${idOf(l.initiativeId)}`, (minutes.get(`initiative:${idOf(l.initiativeId)}`) ?? 0) + (l.timeSpentMinutes || 0));
    if (l.devProjectId) minutes.set(`project:${idOf(l.devProjectId)}`, (minutes.get(`project:${idOf(l.devProjectId)}`) ?? 0) + (l.timeSpentMinutes || 0));
  }
  return { minutes, strategy };
};
const NO_STRATEGY = { total: 0, minutes: 0, logs: 0, counts: [] };

const groupBy = (list, key) => {
  const by = new Map();
  for (const x of list) {
    const k = idOf(x[key]);
    if (!k) continue;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(x);
  }
  return by;
};

/** Every initiative and project of the brand (cancelled ones too — they count nowhere but can be found), worked out from their tasks and logs. */
const loadWork = async ({ brand, today }) => {
  const [initDocs, projDocs] = await Promise.all([
    StrategicInitiative.find(brandQ(brand)).sort({ createdAt: -1 }).limit(1000).lean(),
    DevProject.find(brandQ(brand)).sort({ createdAt: -1 }).limit(1000).lean(),
  ]);
  const initIds = initDocs.map((d) => d._id);
  const projIds = projDocs.map((d) => d._id);
  const tasks = initIds.length || projIds.length ? await MarketingTask.find({ $or: [{ initiativeId: { $in: initIds } }, { devProjectId: { $in: projIds } }] }).select(TASK_FIELDS).limit(20000).lean() : [];
  const byInit = groupBy(tasks, 'initiativeId');
  const byProj = groupBy(tasks, 'devProjectId');
  const { minutes, strategy } = await logFiguresFor(initIds, projIds);
  const initiatives = initDocs.map((doc) => ({ doc, tasks: byInit.get(idOf(doc)) ?? [], strategy: strategy.get(`initiative:${idOf(doc)}`) ?? NO_STRATEGY, e: S.enrichWork('initiative', doc, byInit.get(idOf(doc)) ?? [], { today, minutes: minutes.get(`initiative:${idOf(doc)}`) ?? 0 }) }));
  const projects = projDocs.map((doc) => ({ doc, tasks: byProj.get(idOf(doc)) ?? [], strategy: strategy.get(`project:${idOf(doc)}`) ?? NO_STRATEGY, e: S.enrichWork('project', doc, byProj.get(idOf(doc)) ?? [], { today, minutes: minutes.get(`project:${idOf(doc)}`) ?? 0 }) }));
  return { initiatives, projects, tasks };
};

/** One initiative / project worked out. */
const loadOne = async (kind, doc, today) => {
  const tasks = await MarketingTask.find(kind === 'project' ? { devProjectId: doc._id } : { initiativeId: doc._id }).select(TASK_FIELDS).limit(2000).lean();
  const key = `${kind}:${idOf(doc)}`;
  const { minutes, strategy } = await logFiguresFor(kind === 'initiative' ? [doc._id] : [], kind === 'project' ? [doc._id] : []);
  return { doc, tasks, strategy: strategy.get(key) ?? NO_STRATEGY, e: S.enrichWork(kind, doc, tasks, { today, minutes: minutes.get(key) ?? 0 }) };
};

const workView = (w, names, plans) => {
  const e = w.e;
  const d = w.doc;
  return {
    kind: e.kind,
    id: e.id,
    title: e.title,
    brand: e.brand,
    focusArea: e.focusArea,
    category: e.category,
    impact: e.impact,
    description: d.description ?? '',
    notes: d.notes ?? '',
    plan: e.planId ? { id: e.planId, title: plans.get(e.planId)?.title ?? '' } : null,
    storedStatus: e.storedStatus,
    status: e.status,
    owner: e.ownerId ? { id: e.ownerId, name: names.get(e.ownerId) ?? '', source: e.ownerSource } : null,
    progress: e.progress,
    progressSource: e.progressSource,
    typedProgress: d.progress ?? null,
    taskCount: e.taskCount,
    doneCount: e.doneCount,
    start: e.start,
    typedStart: d.startDate ?? null,
    due: e.due,
    dueSource: e.dueSource,
    closedDay: e.closedDay,
    minutes: e.minutes,
    // the Strategies log types counted from the logs tied to it (projects worked on, first drafts, meetings, final drafts, executions)
    strategyWork: w.strategy ?? NO_STRATEGY,
    createdAt: d.createdAt,
  };
};

const nameIdsOf = (list) => list.map((w) => w.e.ownerId);

const taskRow = (t, names) => ({ id: idOf(t), title: t.title, assignee: names.get(idOf(t.assigneeId)) ?? '', status: t.status, progress: S.taskProgress(t), dueDate: t.dueDate ?? null, completedAt: t.completedAt ?? null });

const planView = (p, names, counts) => ({
  id: idOf(p),
  title: p.title,
  focusArea: p.focusArea,
  year: p.year,
  brand: p.brand,
  status: p.status,
  statusLabel: S.PLAN_LABEL[p.status] ?? p.status,
  goals: p.goals ?? [],
  description: p.description ?? '',
  owner: p.ownerId ? { id: idOf(p.ownerId), name: names.get(idOf(p.ownerId)) ?? '' } : null,
  initiativeCount: counts?.initiatives.get(idOf(p)) ?? 0,
  projectCount: counts?.projects.get(idOf(p)) ?? 0,
  createdAt: p.createdAt,
});

const findingView = (f) => ({ id: idOf(f), title: f.title, kind: f.kind, kindLabel: S.FINDING_LABEL[f.kind] ?? f.kind, summary: f.summary ?? '', link: f.link ?? '', brand: f.brand, date: f.date, tags: f.tags ?? [], author: f.authorName ?? '', authorId: f.authorId ? idOf(f.authorId) : null, createdAt: f.createdAt });

const reviewView = (r, names, today, links = new Map()) => ({
  id: idOf(r),
  // the plan / project / initiative it reviews, as it stands NOW (null when none is named, or it was deleted)
  linked: r.linkKind && r.linkId ? links.get(`${r.linkKind}:${idOf(r.linkId)}`) ?? { kind: r.linkKind, id: idOf(r.linkId), title: '', missing: true } : null,
  type: r.type,
  periodLabel: r.periodLabel,
  reviewDate: r.reviewDate,
  brand: r.brand,
  summary: r.summary ?? '',
  outcomes: (r.outcomes ?? []).map((o) => ({ text: o.text, state: o.state })),
  scores: S.reviewScores(r.outcomes ?? []),
  actionItems: (r.actionItems ?? []).map((a) => ({
    id: idOf(a),
    text: a.text,
    owner: a.ownerId ? { id: idOf(a.ownerId), name: names.get(idOf(a.ownerId)) ?? '' } : null,
    priority: a.priority,
    targetDate: a.targetDate ?? null,
    status: a.status,
    overdue: a.status !== 'done' && !!a.targetDate && a.targetDate < today,
  })),
  createdBy: r.createdByName ?? '',
  createdAt: r.createdAt,
});

const roadmapItemView = (it, titles = new Map()) => ({
  id: idOf(it),
  year: it.year,
  quarter: it.quarter,
  theme: it.theme ?? '',
  title: it.title,
  brand: it.brand,
  done: !!it.done,
  doneBy: it.done ? it.doneByName ?? '' : '',
  doneAt: it.done ? it.doneAt : null,
  planId: it.planId ? idOf(it.planId) : null,
  initiativeId: it.initiativeId ? idOf(it.initiativeId) : null,
  link: it.initiativeId ? titles.get(idOf(it.initiativeId)) ?? '' : it.planId ? titles.get(idOf(it.planId)) ?? '' : '',
});

const roadmapQuarterView = (q, titles) => ({ quarter: q.quarter, label: q.label, months: q.months, theme: q.theme, total: q.total, done: q.done, pct: q.pct, items: q.items.map((i) => roadmapItemView(i, titles)) });

const checkPlanExists = async (res, planId) => {
  if (planId && !(await StrategicPlan.exists({ _id: planId }))) bad(res, 'That plan no longer exists.');
};
const checkOwnerExists = async (res, ownerId) => {
  if (ownerId && !(await MarketingTeamMember.exists({ _id: ownerId }))) bad(res, 'That team member no longer exists.');
};

// ── setup (what the forms need) ───────────────────────────────────────────────

export const getSetup = asyncHandler(async (req, res) => {
  const v = await viewer(req);
  const [members, plans, initiatives, projects, areaA, areaB, categories] = await Promise.all([
    MarketingTeamMember.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).select('name').lean(),
    StrategicPlan.find({}).sort({ year: -1, title: 1 }).limit(200).select('title year focusArea').lean(),
    StrategicInitiative.find({ status: { $ne: 'cancelled' } }).sort({ title: 1 }).limit(300).select('title').lean(),
    DevProject.find({ status: { $ne: 'cancelled' } }).sort({ name: 1 }).limit(300).select('name').lean(),
    StrategicPlan.distinct('focusArea'),
    StrategicInitiative.distinct('focusArea'),
    DevProject.distinct('category'),
  ]);
  res.json({
    canManage: v.manager,
    me: v.own ? { id: idOf(v.own), name: v.own.name } : null,
    members: members.map((m) => ({ id: idOf(m), name: m.name })),
    plans: plans.map((p) => ({ id: idOf(p), title: p.title, year: p.year })),
    initiatives: initiatives.map((i) => ({ id: idOf(i), title: i.title })),
    projects: projects.map((p) => ({ id: idOf(p), title: p.name })),
    focusAreas: [...new Set([...areaA, ...areaB].filter(Boolean))].sort(),
    categories: categories.filter(Boolean).sort(),
  });
});

// ── Overview ──────────────────────────────────────────────────────────────────

export const getOverview = asyncHandler(async (req, res) => {
  const range = readRange(req, res);
  const y = cleanYear(req.query.year, Number(range.to.slice(0, 4)));
  if (!y.ok) bad(res, y.message);
  const year = y.value;
  const week = S.weekOf(range.today);
  const [work, plansAll, roadmapAll, findingsRaw, reviewsAll] = await Promise.all([
    loadWork({ brand: range.brand, today: range.today }),
    StrategicPlan.find(brandQ(range.brand)).sort({ year: -1, createdAt: -1 }).limit(500).lean(),
    RoadmapItem.find({ year, ...brandQ(range.brand) }).sort({ createdAt: 1 }).limit(500).lean(),
    ResearchFinding.find({ ...brandQ(range.brand) }).sort({ date: -1, createdAt: -1 }).limit(500).lean(),
    StrategyReview.find({ ...brandQ(range.brand) }).sort({ reviewDate: -1, createdAt: -1 }).limit(200).lean(),
  ]);
  const inits = work.initiatives.filter((w) => S.workInRange(w.e, range));
  const projs = work.projects.filter((w) => S.workInRange(w.e, range));
  const plans = S.plansInRange(plansAll, range);
  const pc = S.planCounts(plans);
  const ic = S.workCounts(inits.map((w) => w.e));
  const findingsIn = S.findingsInRange(findingsRaw, range);

  // Recent Updates: only real changes in the range
  const live = new Map([...work.initiatives, ...work.projects].filter((w) => w.e.status !== 'cancelled').map((w) => [w.e.id, w.e.title]));
  const taskDone = work.tasks.filter((t) => t.status === 'completed' && t.completedAt && live.has(idOf(t.initiativeId ?? t.devProjectId)));
  const [roadmapTicked, reviewsMade] = await Promise.all([
    RoadmapItem.find({ done: true, doneAt: { $gte: istStart(range.from), $lt: istEnd(range.to) }, ...brandQ(range.brand) }).limit(100).lean(),
    StrategyReview.find({ createdAt: { $gte: istStart(range.from), $lt: istEnd(range.to) }, ...brandQ(range.brand) }).limit(100).lean(),
  ]);
  const findingsMade = findingsRaw.filter((f) => f.createdAt && T.istDay(f.createdAt) >= range.from && T.istDay(f.createdAt) <= range.to);

  // the Strategies log types logged in the range (all initiatives and projects, and work logged with no link)
  const strategyNames = await strategyMetricNames();
  const rangeLogs = strategyNames.size
    ? await MarketingActivity.find({ entryDate: { $gte: range.from, $lte: range.to }, 'values.metricId': { $in: [...strategyNames.keys()].map((id) => new mongoose.Types.ObjectId(id)) }, ...brandQ(range.brand) }).select('initiativeId devProjectId timeSpentMinutes values').limit(20000).lean()
    : [];
  const strategyInRange = S.strategyLogCounts(rangeLogs, (id) => strategyNames.get(id)).get('all') ?? NO_STRATEGY;

  const topInits = [...inits].sort((a, b) => S.byDueOpenFirst(a.e, b.e)).slice(0, 5);
  const topProjs = [...projs].sort((a, b) => S.byDueOpenFirst(a.e, b.e)).slice(0, 3);
  const latest = S.latestReview(reviewsAll, range.to);
  const names = await loadNames([...nameIdsOf(topInits), ...nameIdsOf(topProjs), ...taskDone.map((t) => idOf(t.assigneeId))]);
  const planMap = new Map(plansAll.map((p) => [idOf(p), p]));
  const titles = new Map([...live, ...plansAll.map((p) => [idOf(p), p.title])]);
  const quarters = S.roadmapQuarters(roadmapAll, year);

  res.json({
    from: range.from,
    to: range.to,
    brand: range.brand,
    year,
    kpis: {
      activeStrategies: pc.active,
      developmentProjects: projs.length,
      totalInitiatives: ic.total,
      onTrack: ic.onTrack,
      atRisk: ic.atRisk,
      newThisWeek: S.newThisWeek([...plansAll, ...work.initiatives.map((w) => w.doc), ...work.projects.map((w) => w.doc)], { weekFrom: week.from, weekTo: week.to, brand: range.brand }),
    },
    focusAreas: { total: pc.active, rows: S.focusAreaBreakdown(plans) },
    roadmap: { year, quarters: quarters.map((q) => roadmapQuarterView(q, titles)) },
    initiatives: topInits.map((w) => workView(w, names, planMap)),
    projects: topProjs.map((w) => workView(w, names, planMap)),
    performance: S.performanceByFocusArea(inits.map((w) => w.e)),
    recentUpdates: S.recentUpdates(
      {
        tasks: taskDone.map((t) => ({ ...t, workTitle: live.get(idOf(t.initiativeId ?? t.devProjectId)), assignee: names.get(idOf(t.assigneeId)) ?? '' })),
        roadmap: roadmapTicked,
        reviews: reviewsMade,
        findings: findingsMade,
        plans: plansAll,
        work: [...work.initiatives.filter((w) => w.e.status !== 'cancelled').map((w) => ({ kind: 'initiative', title: w.e.title, createdAt: w.doc.createdAt, _id: w.doc._id })), ...work.projects.filter((w) => w.e.status !== 'cancelled').map((w) => ({ kind: 'project', title: w.e.title, createdAt: w.doc.createdAt, _id: w.doc._id }))],
      },
      range,
      12,
    ),
    research: findingsIn.slice(0, 3).map(findingView),
    // the Strategies log types counted in the range — every type listed, so a step nobody logged reads 0 logged (it is a count of logs)
    strategyWork: { ...strategyInRange, types: [...strategyNames.values()], tracked: strategyNames.size > 0 },
    keyOutcomes: latest ? { review: { id: idOf(latest), type: latest.type, periodLabel: latest.periodLabel, reviewDate: latest.reviewDate }, outcomes: latest.outcomes.map((o) => ({ text: o.text, state: o.state })), scores: S.reviewScores(latest.outcomes) } : null,
  });
});

// ── Strategic Plans ───────────────────────────────────────────────────────────

export const listPlans = asyncHandler(async (req, res) => {
  const range = readRange(req, res);
  const plansAll = await StrategicPlan.find(brandQ(range.brand)).sort({ year: -1, createdAt: -1 }).limit(500).lean();
  const plans = S.plansInRange(plansAll, range);
  const ids = plans.map((p) => p._id);
  const [inits, projs] = ids.length ? await Promise.all([StrategicInitiative.find({ planId: { $in: ids }, status: { $ne: 'cancelled' } }).select('planId').lean(), DevProject.find({ planId: { $in: ids }, status: { $ne: 'cancelled' } }).select('planId').lean()]) : [[], []];
  const counts = { initiatives: new Map([...groupBy(inits, 'planId')].map(([k, v]) => [k, v.length])), projects: new Map([...groupBy(projs, 'planId')].map(([k, v]) => [k, v.length])) };
  const names = await loadNames(plans.map((p) => idOf(p.ownerId)));
  const pc = S.planCounts(plans);
  res.json({
    from: range.from,
    to: range.to,
    brand: range.brand,
    counts: pc,
    focusAreas: { total: pc.active, rows: S.focusAreaBreakdown(plans) },
    progress: { total: pc.total, slices: S.planStatusSlices(plans) },
    goals: S.keyGoals(plans, 8),
    items: plans.map((p) => planView(p, names, counts)),
  });
});

export const createPlan = asyncHandler(async (req, res) => {
  const v = await viewer(req);
  needManager(v, res, 'Only a Marketing Manager can add a strategic plan.');
  const c = cleanPlanInput({ year: Number(toDateStr().slice(0, 4)), ...req.body });
  if (!c.ok) bad(res, c.message);
  await checkOwnerExists(res, c.value.ownerId);
  const plan = await StrategicPlan.create({ ...c.value, createdBy: req.user._id, lastEditedBy: req.user._id });
  res.status(201).json(planView(plan.toObject(), await loadNames([idOf(plan.ownerId)])));
});

export const updatePlan = asyncHandler(async (req, res) => {
  const v = await viewer(req);
  needManager(v, res, 'Only a Marketing Manager can change a strategic plan.');
  validId(res, req.params.id, 'plan');
  const plan = await StrategicPlan.findById(req.params.id);
  if (!plan) bad(res, 'That plan was not found.', 404);
  const c = cleanPlanInput(req.body, plan.toObject());
  if (!c.ok) bad(res, c.message);
  await checkOwnerExists(res, c.value.ownerId);
  Object.assign(plan, c.value, { lastEditedBy: req.user._id });
  await plan.save();
  res.json(planView(plan.toObject(), await loadNames([idOf(plan.ownerId)])));
});

export const deletePlan = asyncHandler(async (req, res) => {
  const v = await viewer(req);
  needManager(v, res, 'Only a Marketing Manager can delete a strategic plan.');
  validId(res, req.params.id, 'plan');
  const plan = await StrategicPlan.findById(req.params.id);
  if (!plan) bad(res, 'That plan was not found.', 404);
  // the work that served the plan stays; it just stops pointing at a plan that is gone
  await Promise.all([StrategicInitiative.updateMany({ planId: plan._id }, { $set: { planId: null } }), DevProject.updateMany({ planId: plan._id }, { $set: { planId: null } }), RoadmapItem.updateMany({ planId: plan._id }, { $set: { planId: null } })]);
  await plan.deleteOne();
  res.json({ message: 'Plan deleted' });
});

// ── Initiatives and Development Projects (they share everything) ─────────────

const STATUS_FILTERS = { open: S.OPEN_STATUSES, on_track: ['on_track'], in_progress: ['in_progress'], at_risk: ['at_risk'], on_hold: ['on_hold'], completed: ['completed'], cancelled: ['cancelled'] };

/** The list endpoints: KPIs over the range, the table filtered by status / focus area / search and paged. */
const listWork = (kind) =>
  asyncHandler(async (req, res) => {
    const range = readRange(req, res);
    const { page, limit } = cleanPaging(req.query);
    const work = await loadWork({ brand: range.brand, today: range.today });
    const all = kind === 'project' ? work.projects : work.initiatives;
    const inRange = all.filter((w) => S.workInRange(w.e, range));
    const counts = S.workCounts(inRange.map((w) => w.e));
    const status = String(req.query.status ?? 'all');
    let list = status === 'cancelled' ? all.filter((w) => w.e.status === 'cancelled') : inRange;
    if (STATUS_FILTERS[status] && status !== 'cancelled') list = list.filter((w) => STATUS_FILTERS[status].includes(w.e.status));
    const area = String(req.query.focusArea ?? '').trim();
    if (area) list = list.filter((w) => (w.e.focusArea || S.OTHERS) === area);
    const text = String(req.query.q ?? '').trim();
    if (text) {
      const rx = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      list = list.filter((w) => rx.test(w.e.title) || rx.test(w.e.focusArea) || rx.test(w.e.category));
    }
    list = [...list].sort((a, b) => S.byDueOpenFirst(a.e, b.e));
    const paged = list.slice((page - 1) * limit, page * limit);
    const names = await loadNames(nameIdsOf(paged));
    const plans = await loadPlans();
    res.json({
      from: range.from,
      to: range.to,
      brand: range.brand,
      counts,
      focusAreas: [...new Set(inRange.map((w) => w.e.focusArea).filter(Boolean))].sort(),
      total: list.length,
      page,
      pageSize: limit,
      items: paged.map((w) => workView(w, names, plans)),
    });
  });
export const listInitiatives = listWork('initiative');
export const listProjects = listWork('project');

const workDetail = (kind, Model) =>
  asyncHandler(async (req, res) => {
    validId(res, req.params.id, kind === 'project' ? 'project' : 'initiative');
    const doc = await Model.findById(req.params.id).lean();
    if (!doc) bad(res, `That ${kind === 'project' ? 'project' : 'initiative'} was not found.`, 404);
    const w = await loadOne(kind, doc, toDateStr());
    const logs = await MarketingActivity.find(kind === 'initiative' ? { initiativeId: doc._id } : { devProjectId: doc._id }).sort({ entryDate: -1, loggedAt: -1 }).limit(10).select('memberId workedOn timeSpentMinutes entryDate status').lean();
    const names = await loadNames([w.e.ownerId, ...w.tasks.map((t) => idOf(t.assigneeId)), ...logs.map((l) => idOf(l.memberId))]);
    const plans = await loadPlans();
    res.json({
      ...workView(w, names, plans),
      tasks: [...w.tasks].sort((a, b) => (a.status === 'completed') - (b.status === 'completed') || (a.dueDate ?? '9999') .localeCompare(b.dueDate ?? '9999')).map((t) => taskRow(t, names)),
      logs: logs.map((l) => ({ id: idOf(l), member: names.get(idOf(l.memberId)) ?? '', workedOn: l.workedOn, minutes: l.timeSpentMinutes ?? 0, day: l.entryDate, status: l.status })),
    });
  });
export const getInitiative = workDetail('initiative', StrategicInitiative);
export const getProject = workDetail('project', DevProject);

/** Who may change this record: a manager, or its owner (the owner chosen on it; with none chosen, the person who made it). */
const ownsWork = (v, doc, user) => (v.own && doc.ownerId ? idOf(doc.ownerId) === idOf(v.own) : !doc.ownerId && idOf(doc.createdBy) === idOf(user._id));

export const createInitiative = asyncHandler(async (req, res) => {
  const v = await viewer(req);
  needTeam(v, res);
  const c = cleanInitiativeInput(req.body);
  if (!c.ok) bad(res, c.message);
  const val = c.value;
  if (!v.manager) {
    if (val.status && val.status !== 'active') bad(res, 'Only a Marketing Manager can set the status.', 403);
    if (val.ownerId && val.ownerId !== idOf(v.own)) bad(res, 'Only a Marketing Manager can give an initiative to someone else.', 403);
  }
  await Promise.all([checkPlanExists(res, val.planId), checkOwnerExists(res, val.ownerId)]);
  const doc = await StrategicInitiative.create({ ...val, ownerId: val.ownerId === undefined ? (v.own ? v.own._id : null) : val.ownerId, completedAt: val.status === 'completed' ? new Date() : null, createdBy: req.user._id, lastEditedBy: req.user._id });
  const w = await loadOne('initiative', doc.toObject(), toDateStr());
  res.status(201).json(workView(w, await loadNames([w.e.ownerId]), await loadPlans()));
});

export const createProject = asyncHandler(async (req, res) => {
  const v = await viewer(req);
  needManager(v, res, 'Only a Marketing Manager can add a development project.');
  const c = cleanProjectInput(req.body);
  if (!c.ok) bad(res, c.message);
  await Promise.all([checkPlanExists(res, c.value.planId), checkOwnerExists(res, c.value.ownerId)]);
  const doc = await DevProject.create({ ...c.value, completedAt: c.value.status === 'completed' ? new Date() : null, createdBy: req.user._id, lastEditedBy: req.user._id });
  const w = await loadOne('project', doc.toObject(), toDateStr());
  res.status(201).json(workView(w, await loadNames([w.e.ownerId]), await loadPlans()));
});

const updateWork = (kind, Model, clean) =>
  asyncHandler(async (req, res) => {
    const label = kind === 'project' ? 'project' : 'initiative';
    const v = await viewer(req);
    needTeam(v, res);
    validId(res, req.params.id, label);
    const doc = await Model.findById(req.params.id);
    if (!doc) bad(res, `That ${label} was not found.`, 404);
    if (!v.manager && !ownsWork(v, doc, req.user)) bad(res, `You can only change an ${label} you own.`, 403);
    const c = clean(req.body, doc.toObject());
    if (!c.ok) bad(res, c.message);
    const val = c.value;
    if (!v.manager) {
      if (val.status !== undefined && val.status !== doc.status) bad(res, 'Only a Marketing Manager can set the status.', 403);
      if (val.ownerId !== undefined && val.ownerId !== idOf(doc.ownerId) && !(val.ownerId === null && !doc.ownerId)) bad(res, `Only a Marketing Manager can give an ${label} to someone else.`, 403);
      delete val.status;
      delete val.ownerId;
    }
    await Promise.all([checkPlanExists(res, val.planId), checkOwnerExists(res, val.ownerId)]);
    const was = doc.status;
    Object.assign(doc, val, { lastEditedBy: req.user._id });
    if (doc.status === 'completed' && was !== 'completed') doc.completedAt = new Date();
    if (doc.status !== 'completed' && was === 'completed') doc.completedAt = null;
    await doc.save();
    const w = await loadOne(kind, doc.toObject(), toDateStr());
    res.json(workView(w, await loadNames([w.e.ownerId]), await loadPlans()));
  });
export const updateInitiative = updateWork('initiative', StrategicInitiative, cleanInitiativeInput);
export const updateProject = updateWork('project', DevProject, cleanProjectInput);

const deleteWork = (kind, Model) =>
  asyncHandler(async (req, res) => {
    const label = kind === 'project' ? 'project' : 'initiative';
    const v = await viewer(req);
    needManager(v, res, `Only a Marketing Manager can delete an ${label}.`);
    validId(res, req.params.id, label);
    const doc = await Model.findById(req.params.id);
    if (!doc) bad(res, `That ${label} was not found.`, 404);
    const [tasks, logs] = await Promise.all([
      MarketingTask.countDocuments(kind === 'project' ? { devProjectId: doc._id } : { initiativeId: doc._id }),
      MarketingActivity.countDocuments(kind === 'project' ? { devProjectId: doc._id } : { initiativeId: doc._id }),
    ]);
    if (tasks || logs) bad(res, `This ${label} has ${tasks ? `${tasks} task${tasks === 1 ? '' : 's'}` : ''}${tasks && logs ? ' and ' : ''}${logs ? `${logs} logged ${logs === 1 ? 'entry' : 'entries'}` : ''} tied to it. Cancel it instead, so the record stays.`, 409);
    if (kind === 'initiative') await RoadmapItem.updateMany({ initiativeId: doc._id }, { $set: { initiativeId: null } });
    await doc.deleteOne();
    res.json({ message: `${kind === 'project' ? 'Project' : 'Initiative'} deleted` });
  });
export const deleteInitiative = deleteWork('initiative', StrategicInitiative);
export const deleteProject = deleteWork('project', DevProject);

// ── Roadmap ───────────────────────────────────────────────────────────────────

export const getRoadmap = asyncHandler(async (req, res) => {
  const range = readRange(req, res);
  const y = cleanYear(req.query.year, Number(range.to.slice(0, 4)));
  if (!y.ok) bad(res, y.message);
  const year = y.value;
  const [items, work, plans] = await Promise.all([RoadmapItem.find({ year, ...brandQ(range.brand) }).sort({ createdAt: 1 }).limit(500).lean(), loadWork({ brand: range.brand, today: range.today }), loadPlans()]);
  const quarters = S.roadmapQuarters(items, year);
  const live = [...work.initiatives, ...work.projects].filter((w) => w.e.status !== 'cancelled');
  const titles = new Map([...live.map((w) => [w.e.id, w.e.title]), ...[...plans].map(([k, p]) => [k, p.title])]);
  const names = await loadNames(nameIdsOf(live));
  const bars = [];
  const undated = [];
  for (const w of live) {
    const bar = S.timelineBar(w.e, year);
    const span = S.spanOf(w.e);
    const row = { kind: w.e.kind, id: w.e.id, title: w.e.title, owner: w.e.ownerId ? names.get(w.e.ownerId) ?? '' : '', progress: w.e.progress, progressSource: w.e.progressSource, status: w.e.status, start: w.e.start, end: span.end };
    if (bar) bars.push({ ...row, ...bar });
    else if (!span.end && span.start <= `${year}-12-31`) undated.push(row);
  }
  bars.sort((a, b) => a.from - b.from || a.title.localeCompare(b.title));
  const done = items.filter((i) => i.done).length;
  res.json({
    from: range.from,
    to: range.to,
    brand: range.brand,
    year,
    counts: { items: items.length, done, pct: items.length ? Math.round((done / items.length) * 100) : null },
    quarters: quarters.map((q) => roadmapQuarterView(q, titles)),
    timeline: { year, bars, undated },
  });
});

export const createRoadmapItem = asyncHandler(async (req, res) => {
  const v = await viewer(req);
  needManager(v, res, 'Only a Marketing Manager can add a roadmap line.');
  const c = cleanRoadmapInput(req.body);
  if (!c.ok) bad(res, c.message);
  await checkPlanExists(res, c.value.planId);
  if (c.value.initiativeId && !(await StrategicInitiative.exists({ _id: c.value.initiativeId }))) bad(res, 'That initiative no longer exists.');
  const item = await RoadmapItem.create({ ...c.value, createdBy: req.user._id });
  res.status(201).json(roadmapItemView(item.toObject()));
});

export const updateRoadmapItem = asyncHandler(async (req, res) => {
  const v = await viewer(req);
  needManager(v, res, 'Only a Marketing Manager can change a roadmap line.');
  validId(res, req.params.id, 'roadmap line');
  const item = await RoadmapItem.findById(req.params.id);
  if (!item) bad(res, 'That roadmap line was not found.', 404);
  const c = cleanRoadmapInput(req.body, item.toObject());
  if (!c.ok) bad(res, c.message);
  await checkPlanExists(res, c.value.planId);
  if (c.value.initiativeId && !(await StrategicInitiative.exists({ _id: c.value.initiativeId }))) bad(res, 'That initiative no longer exists.');
  Object.assign(item, c.value);
  await item.save();
  res.json(roadmapItemView(item.toObject()));
});

export const deleteRoadmapItem = asyncHandler(async (req, res) => {
  const v = await viewer(req);
  needManager(v, res, 'Only a Marketing Manager can delete a roadmap line.');
  validId(res, req.params.id, 'roadmap line');
  const item = await RoadmapItem.findById(req.params.id);
  if (!item) bad(res, 'That roadmap line was not found.', 404);
  await item.deleteOne();
  res.json({ message: 'Roadmap line deleted' });
});

/** Members tick a milestone off (and take the tick back): who did it and when is kept. */
export const tickRoadmapItem = asyncHandler(async (req, res) => {
  const v = await viewer(req);
  needTeam(v, res);
  validId(res, req.params.id, 'roadmap line');
  const c = cleanTick(req.body);
  if (!c.ok) bad(res, c.message);
  const item = await RoadmapItem.findById(req.params.id);
  if (!item) bad(res, 'That roadmap line was not found.', 404);
  if (c.value.done && !item.done) {
    item.done = true;
    item.doneAt = new Date();
    item.doneBy = req.user._id;
    item.doneByName = v.own?.name ?? req.user.name ?? '';
  } else if (!c.value.done && item.done) {
    item.done = false;
    item.doneAt = null;
    item.doneBy = null;
    item.doneByName = '';
  }
  await item.save();
  res.json(roadmapItemView(item.toObject()));
});

// ── Research & Insights ───────────────────────────────────────────────────────

/**
 * The enquiry trend (utils/marketingStrategyStats.js enquiryTrend): our own leads so far this quarter against the same number of days of
 * the quarter before, by the Lead Report's rules, for the brand — and only the leads this viewer may see (the CRM's own rule).
 */
const loadEnquiryTrend = async (req, range) => {
  const today = range.today;
  const q = S.quarterOf(today);
  const prevStart = S.quarterOf(T.addDays(q.from, -1)).from;
  const scope = await leadScopeFor(req.user);
  const a = istStart(prevStart);
  const z = istEnd(today);
  const raw = await Lead.find({ ...scope, $or: [{ leadDate: { $gte: a, $lt: z } }, { leadDate: null, createdAt: { $gte: a, $lt: z } }] })
    .select('source region district campaignId leadDate createdAt')
    .limit(LEAD_CAP)
    .lean();
  const leads = await withBrands(raw); // a lead from a campaign belongs to the campaign's brand — the Lead Report's own brand rule
  return { ...S.enquiryTrend({ leads, today, brand: range.brand }), capped: raw.length >= LEAD_CAP };
};

export const listFindings = asyncHandler(async (req, res) => {
  const range = readRange(req, res);
  const { page, limit } = cleanPaging(req.query);
  const raw = await ResearchFinding.find(brandQ(range.brand)).sort({ date: -1, createdAt: -1 }).limit(1000).lean();
  const inRange = S.findingsInRange(raw, range);
  const kind = String(req.query.kind ?? 'all');
  let list = ['report', 'market_insight', 'competitor', 'opportunity'].includes(kind) ? inRange.filter((f) => f.kind === kind) : inRange;
  const text = String(req.query.q ?? '').trim();
  if (text) {
    const rx = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    list = list.filter((f) => rx.test(f.title) || rx.test(f.summary ?? '') || (f.tags ?? []).some((t) => rx.test(t)));
  }
  res.json({
    from: range.from,
    to: range.to,
    brand: range.brand,
    enquiryTrend: await loadEnquiryTrend(req, range),
    counts: S.researchCounts(inRange),
    keyInsights: inRange.filter((f) => f.kind === 'market_insight').slice(0, 5).map(findingView),
    opportunities: inRange.filter((f) => f.kind === 'opportunity').slice(0, 5).map(findingView),
    total: list.length,
    page,
    pageSize: limit,
    items: list.slice((page - 1) * limit, page * limit).map(findingView),
  });
});

export const createFinding = asyncHandler(async (req, res) => {
  const v = await viewer(req);
  needTeam(v, res);
  const c = cleanFindingInput(req.body, null, { today: toDateStr() });
  if (!c.ok) bad(res, c.message);
  const f = await ResearchFinding.create({ ...c.value, authorId: v.own ? v.own._id : null, authorName: v.own?.name ?? req.user.name ?? '', createdBy: req.user._id });
  res.status(201).json(findingView(f.toObject()));
});

const findingFor = async (req, res) => {
  const v = await viewer(req);
  needTeam(v, res);
  validId(res, req.params.id, 'finding');
  const f = await ResearchFinding.findById(req.params.id);
  if (!f) bad(res, 'That finding was not found.', 404);
  const mine = (v.own && f.authorId && idOf(f.authorId) === idOf(v.own)) || idOf(f.createdBy) === idOf(req.user._id);
  return { v, f, mine };
};

export const updateFinding = asyncHandler(async (req, res) => {
  const { v, f, mine } = await findingFor(req, res);
  if (!v.manager && !mine) bad(res, 'You can only change a finding you added.', 403);
  const c = cleanFindingInput(req.body, f.toObject(), { today: toDateStr() });
  if (!c.ok) bad(res, c.message);
  Object.assign(f, c.value);
  await f.save();
  res.json(findingView(f.toObject()));
});

export const deleteFinding = asyncHandler(async (req, res) => {
  const { v, f, mine } = await findingFor(req, res);
  if (!v.manager && !mine) bad(res, 'You can only delete a finding you added.', 403);
  await f.deleteOne();
  res.json({ message: 'Finding deleted' });
});

// ── Reviews ───────────────────────────────────────────────────────────────────

export const listReviews = asyncHandler(async (req, res) => {
  const range = readRange(req, res);
  const type = String(req.query.type ?? 'all');
  const raw = await StrategyReview.find(brandQ(range.brand)).sort({ reviewDate: -1, createdAt: -1 }).limit(500).lean();
  const inRange = S.reviewsInRange(raw, range);
  const list = ['strategy', 'project', 'campaign', 'quarterly'].includes(type) ? inRange.filter((r) => r.type === type) : inRange;
  const shown = list.slice(0, 50);
  const names = await loadNames(shown.flatMap((r) => r.actionItems.map((a) => idOf(a.ownerId))));
  const links = await loadReviewLinks(shown, range.today);
  res.json({
    from: range.from,
    to: range.to,
    brand: range.brand,
    type,
    counts: { strategy: inRange.filter((r) => r.type === 'strategy').length, project: inRange.filter((r) => r.type === 'project').length, campaign: inRange.filter((r) => r.type === 'campaign').length, quarterly: inRange.filter((r) => r.type === 'quarterly').length },
    items: shown.map((r) => reviewView(r, names, range.today, links)),
  });
});

/**
 * The records these reviews are about, worked out NOW: a plan's status (and how many initiatives / projects serve it); a project's or an
 * initiative's progress and status by the same rules as its own screen. → Map<'kind:id', { kind, id, title, status, statusLabel, progress, progressSource }>
 */
const loadReviewLinks = async (reviews, today) => {
  const ids = (kind) => [...new Set(reviews.filter((r) => r.linkKind === kind && r.linkId).map((r) => idOf(r.linkId)))].filter((x) => mongoose.isValidObjectId(x));
  const [planIds, projIds, initIds] = [ids('plan'), ids('project'), ids('initiative')];
  const out = new Map();
  if (planIds.length) {
    for (const p of await StrategicPlan.find({ _id: { $in: planIds } }).lean()) out.set(`plan:${idOf(p)}`, { kind: 'plan', id: idOf(p), title: p.title, status: p.status, statusLabel: S.PLAN_LABEL[p.status] ?? p.status, progress: null, progressSource: 'none', year: p.year });
  }
  for (const [kind, Model, list] of [['project', DevProject, projIds], ['initiative', StrategicInitiative, initIds]]) {
    if (!list.length) continue;
    for (const doc of await Model.find({ _id: { $in: list } }).lean()) {
      const w = await loadOne(kind, doc, today);
      out.set(`${kind}:${idOf(doc)}`, { kind, id: w.e.id, title: w.e.title, status: w.e.status, statusLabel: S.STATUS_LABEL[w.e.status] ?? w.e.status, progress: w.e.progress, progressSource: w.e.progressSource, due: w.e.due ?? null });
    }
  }
  return out;
};

/** A review's link must point at a record that exists. */
const checkReviewLink = async (res, v) => {
  if (!v.linkKind || !v.linkId) return;
  const Model = { plan: StrategicPlan, project: DevProject, initiative: StrategicInitiative }[v.linkKind];
  if (!(await Model.exists({ _id: v.linkId }))) bad(res, `That ${v.linkKind === 'project' ? 'development project' : v.linkKind} no longer exists.`);
};

/** Action items of a review get their own id; an id the app sends back keeps its place (so a tick survives an edit). */
const actionDocs = (items, existing = []) => {
  const have = new Set(existing.map((a) => idOf(a)));
  return items.map((a) => ({ ...(a.id && have.has(a.id) ? { _id: a.id } : {}), text: a.text, ownerId: a.ownerId, priority: a.priority, targetDate: a.targetDate, status: a.status }));
};

const checkActionOwners = async (res, items) => {
  const ids = [...new Set(items.map((a) => a.ownerId).filter(Boolean))];
  if (ids.length && (await MarketingTeamMember.countDocuments({ _id: { $in: ids } })) !== ids.length) bad(res, 'An action item is given to a team member who no longer exists.');
};

export const createReview = asyncHandler(async (req, res) => {
  const v = await viewer(req);
  needManager(v, res, 'Only a Marketing Manager can add a review.');
  const today = toDateStr();
  const c = cleanReviewInput(req.body, null, { today });
  if (!c.ok) bad(res, c.message);
  await checkActionOwners(res, c.value.actionItems ?? []);
  await checkReviewLink(res, c.value);
  const r = await StrategyReview.create({ ...c.value, actionItems: actionDocs(c.value.actionItems ?? []), createdBy: req.user._id, createdByName: v.own?.name ?? req.user.name ?? '', lastEditedBy: req.user._id });
  const doc = r.toObject();
  res.status(201).json(reviewView(doc, await loadNames(doc.actionItems.map((a) => idOf(a.ownerId))), today, await loadReviewLinks([doc], today)));
});

export const updateReview = asyncHandler(async (req, res) => {
  const v = await viewer(req);
  needManager(v, res, 'Only a Marketing Manager can change a review.');
  validId(res, req.params.id, 'review');
  const r = await StrategyReview.findById(req.params.id);
  if (!r) bad(res, 'That review was not found.', 404);
  const today = toDateStr();
  const c = cleanReviewInput(req.body, r.toObject(), { today });
  if (!c.ok) bad(res, c.message);
  const { actionItems, ...rest } = c.value;
  if (actionItems) {
    await checkActionOwners(res, actionItems);
    r.actionItems = actionDocs(actionItems, r.actionItems);
  }
  await checkReviewLink(res, rest);
  Object.assign(r, rest, { lastEditedBy: req.user._id });
  await r.save();
  const doc = r.toObject();
  res.json(reviewView(doc, await loadNames(doc.actionItems.map((a) => idOf(a.ownerId))), today, await loadReviewLinks([doc], today)));
});

export const deleteReview = asyncHandler(async (req, res) => {
  const v = await viewer(req);
  needManager(v, res, 'Only a Marketing Manager can delete a review.');
  validId(res, req.params.id, 'review');
  const r = await StrategyReview.findById(req.params.id);
  if (!r) bad(res, 'That review was not found.', 404);
  await r.deleteOne();
  res.json({ message: 'Review deleted' });
});

/** The owner of an action item ticks it (Open → In progress → Done); a manager can too. */
export const updateReviewAction = asyncHandler(async (req, res) => {
  const v = await viewer(req);
  needTeam(v, res);
  validId(res, req.params.id, 'review');
  validId(res, req.params.actionId, 'action item');
  const c = cleanActionStatus(req.body);
  if (!c.ok) bad(res, c.message);
  const r = await StrategyReview.findById(req.params.id);
  if (!r) bad(res, 'That review was not found.', 404);
  const a = r.actionItems.id(req.params.actionId);
  if (!a) bad(res, 'That action item was not found.', 404);
  if (!v.manager && !(v.own && a.ownerId && idOf(a.ownerId) === idOf(v.own))) bad(res, 'You can only change the action items given to you.', 403);
  a.status = c.value.status;
  r.lastEditedBy = req.user._id;
  await r.save();
  const doc = r.toObject();
  res.json(reviewView(doc, await loadNames(doc.actionItems.map((x) => idOf(x.ownerId))), toDateStr(), await loadReviewLinks([doc], toDateStr())));
});
