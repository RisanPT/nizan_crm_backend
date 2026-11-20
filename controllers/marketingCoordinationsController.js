import asyncHandler from 'express-async-handler';
import mongoose from 'mongoose';
import CoordRequest from '../models/CoordRequest.js';
import CoordApproval from '../models/CoordApproval.js';
import CoordMeeting from '../models/CoordMeeting.js';
import CoordFollowUp from '../models/CoordFollowUp.js';
import ContentItem from '../models/ContentItem.js';
import MarketingAsset from '../models/MarketingAsset.js';
import MarketingTask from '../models/MarketingTask.js';
import User from '../models/User.js';
import { MarketingTeamMember, MarketingMemberRole } from '../models/MarketingEod.js';
import { notify, NOTIFICATION_TYPES } from '../utils/notify.js';
import { LEADERSHIP_ROLES, leadershipTitle } from '../utils/leadership.js';
import { managerUserIds } from '../services/marketingEodReminders.js';
import { sweepFollowUpReminders } from '../services/marketingCoordReminders.js';
import { toDateStr, isManagerOrAdmin, findOwnMember } from './marketingEodController.js';
import { isDay } from '../utils/marketingActivityInput.js';
import { cleanRequestInput, cleanApprovalInput, cleanDecisionInput, cleanMeetingInput, cleanFollowUpInput } from '../utils/marketingCoordinationInput.js';
import * as S from '../utils/marketingCoordinationStats.js';
import * as T from '../utils/marketingTeamStats.js';

// Coordinations — Overview, Requests & Tasks, Inter-Department, Approvals, Meetings, Follow-ups. Routes:
// routes/marketingCoordinationsRoutes.js, /api/marketing/coordinations. Every number is defined in
// utils/marketingCoordinationStats.js; a request or approval a member logs counts toward the totals, the status tiles and the on-time
// rate, and what is waiting for review comes from the real posts (Socials) and assets (Creative Portfolio) — nothing is typed twice.
//   members create and update their own requests / follow-ups / meetings (the ones they raised, are assigned, or attend);
//   a Marketing Manager / admin changes anything and is the only one who decides an approval; leaders read only (the CEO guard).

const IST = 5.5 * 3600 * 1000;
const istStart = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - IST);
const istEnd = (day) => istStart(T.addDays(day, 1));
const idOf = (v) => (v == null ? '' : String(v._id ?? v));
const bad = (res, message, status = 400) => {
  res.status(status);
  throw new Error(message);
};
const LIMIT_ROWS = 3000;

/** ?from=&to=&brand=&dept= → the checked range (default: this week, Monday to Sunday). */
const readRange = (req, res) => {
  const today = toDateStr();
  const week = S.weekRange(today);
  const from = req.query.from ?? week.from;
  const to = req.query.to ?? week.to;
  if (!isDay(from) || !isDay(to)) bad(res, 'The dates must be YYYY-MM-DD.');
  if (to < from) bad(res, 'The end date is before the start date.');
  if (T.daysBetween(from, to) > 366) bad(res, 'Choose a range of a year or less.');
  const brand = String(req.query.brand ?? 'all').toLowerCase();
  if (!['all', 'main', 'kerala'].includes(brand)) bad(res, 'Choose All, Main or Kerala.');
  const dept = req.query.dept === undefined || req.query.dept === '' ? 'all' : String(req.query.dept);
  if (dept !== 'all' && !S.DEPARTMENTS.includes(dept)) bad(res, 'Unknown department.');
  return { from, to, brand, dept, today };
};
const brandQuery = (brand) => (brand === 'all' ? {} : { brand });
const pageOf = (req, dflt = 10) => ({ page: Math.max(parseInt(req.query.page, 10) || 1, 1), limit: Math.min(Math.max(parseInt(req.query.limit, 10) || dflt, 1), 50) });

/** Who is asking: their team-member record (if any), and whether they are a Marketing Manager / admin. */
const whoIs = async (req) => {
  const own = await findOwnMember(req.user);
  return { own, ownId: own ? idOf(own) : '', manager: isManagerOrAdmin(req.user), userId: idOf(req.user._id) };
};

const memberNames = async (ids) => {
  const list = [...new Set(ids.map(idOf).filter(Boolean))];
  if (!list.length) return new Map();
  const members = await MarketingTeamMember.find({ _id: { $in: list } }).select('name').lean();
  return new Map(members.map((m) => [idOf(m), m.name]));
};

/** A member must exist for an id the client sent. */
const needMember = async (res, id, label = 'team member') => {
  if (!id) return null;
  const m = await MarketingTeamMember.findById(id).select('name userId').lean();
  if (!m) bad(res, `That ${label} was not found.`);
  return m;
};

// ── views ─────────────────────────────────────────────────────────────────────

const requestView = (r, names, c, today) => ({
  id: idOf(r),
  kind: r.kind,
  title: r.title,
  detail: r.detail ?? '',
  fromDept: r.fromDept,
  toDept: r.toDept,
  requestedById: r.requestedById ? idOf(r.requestedById) : null,
  requestedBy: (r.requestedById && names.get(idOf(r.requestedById))) || r.requestedByName || '',
  assigneeId: r.assigneeId ? idOf(r.assigneeId) : null,
  assignee: (r.assigneeId && names.get(idOf(r.assigneeId))) || r.assigneeName || '',
  priority: r.priority,
  dueDate: r.dueDate ?? null,
  status: r.status,
  progress: S.progressOf(r),
  brand: r.brand ?? 'main',
  stage: r.kind === 'handover' ? S.handoverStage(r.status) : null,
  overdue: S.isOverdue(r, today),
  onTime: r.status === 'completed' && r.dueDate ? S.completedOnTime(r) : null,
  createdAt: r.createdAt,
  closedAt: r.closedAt ?? null,
  nextStatuses: S.nextStatuses(r.status),
  moveTo: S.HANDOVER_STAGES.filter((st) => st.key !== S.handoverStage(r.status) && S.canMoveRequest(r.status, st.status)).map((st) => st.key),
  canEdit: canChangeRequest(r, c),
  canDelete: c.manager || idOf(r.createdBy) === c.userId,
});

const canChangeRequest = (r, c) => c.manager || idOf(r.createdBy) === c.userId || (!!c.ownId && (idOf(r.requestedById) === c.ownId || idOf(r.assigneeId) === c.ownId));

const requestViews = async (list, c, today) => {
  const names = await memberNames(list.flatMap((r) => [r.requestedById, r.assigneeId]));
  return list.map((r) => requestView(r, names, c, today));
};

const approvalView = (a, names, c, today) => ({
  id: idOf(a),
  title: a.title,
  category: a.category,
  amount: a.amount ?? 0,
  impact: a.impact ?? '',
  requestedById: a.requestedById ? idOf(a.requestedById) : null,
  requestedBy: (a.requestedById && names.get(idOf(a.requestedById))) || a.requestedByName || '',
  status: a.status,
  dueDate: a.dueDate ?? null,
  brand: a.brand ?? 'main',
  requestId: a.requestId ? idOf(a.requestId) : null,
  requestedOn: a.createdAt ? T.istDay(a.createdAt) : null,
  createdAt: a.createdAt,
  decidedAt: a.decidedAt ?? null,
  decidedBy: a.decidedByName ?? '',
  decisionNote: a.decisionNote ?? '',
  escalatedAt: a.escalatedAt ?? null,
  escalatedTo: (a.escalatedTo ?? []).map((p) => ({ name: p.name ?? '', title: p.title ?? '' })),
  escalatedToLabel: a.status === 'escalated' || a.escalatedAt ? S.escalationLabel(a.escalatedTo ?? []) : '',
  escalatedBy: a.escalatedByName ?? '',
  overdue: S.AWAITING_APPROVAL.includes(a.status) && !!a.dueDate && a.dueDate < today,
  canDecide: c.manager && S.AWAITING_APPROVAL.includes(a.status),
  canEdit: a.status === 'pending' || a.status === 'in_review' || a.status === 'escalated' ? c.manager || (a.status === 'pending' && (idOf(a.createdBy) === c.userId || (!!c.ownId && idOf(a.requestedById) === c.ownId))) : false,
  canDelete: c.manager || (a.status === 'pending' && idOf(a.createdBy) === c.userId),
});

const approvalViews = async (list, c, today) => {
  const names = await memberNames(list.map((a) => a.requestedById));
  return list.map((a) => approvalView(a, names, c, today));
};

const canChangeMeeting = (m, c) => c.manager || idOf(m.createdBy) === c.userId || (!!c.ownId && (m.attendees ?? []).some((a) => idOf(a.memberId) === c.ownId));

const meetingBrief = (m, now, c) => ({
  id: idOf(m),
  title: m.title,
  startAt: m.startAt,
  endAt: m.endAt,
  day: T.istDay(m.startAt),
  time: S.istTime(m.startAt),
  endTime: S.istTime(m.endAt),
  location: m.location ?? '',
  link: m.link ?? '',
  status: m.status,
  state: S.meetingState(m, now),
  departments: m.departments ?? [],
  brand: m.brand ?? 'main',
  agendaCount: (m.agenda ?? []).length,
  attendeeCount: (m.attendees ?? []).length,
  openActions: (m.actionItems ?? []).filter((i) => !i.done && !i.followUpId).length,
  canEdit: canChangeMeeting(m, c),
  canDelete: c.manager || idOf(m.createdBy) === c.userId,
});

const meetingDetail = async (m, now, c) => {
  const memberIds = [...(m.attendees ?? []).map((a) => a.memberId), ...(m.actionItems ?? []).map((i) => i.ownerId)];
  const names = await memberNames(memberIds);
  const fuIds = (m.actionItems ?? []).map((i) => i.followUpId).filter(Boolean);
  const fus = fuIds.length ? await CoordFollowUp.find({ _id: { $in: fuIds } }).select('status dueDate').lean() : [];
  const byId = new Map(fus.map((f) => [idOf(f), f]));
  return {
    ...meetingBrief(m, now, c),
    agenda: m.agenda ?? [],
    notes: m.notes ?? '',
    completedAt: m.completedAt ?? null,
    attendees: (m.attendees ?? []).map((a) => ({ memberId: a.memberId ? idOf(a.memberId) : null, name: (a.memberId && names.get(idOf(a.memberId))) || a.name || '' })),
    actionItems: (m.actionItems ?? []).map((i) => ({
      id: idOf(i),
      text: i.text,
      ownerId: i.ownerId ? idOf(i.ownerId) : null,
      owner: (i.ownerId && names.get(idOf(i.ownerId))) || i.ownerName || '',
      due: i.due ?? null,
      done: S.actionItemDone(i, byId),
      followUpId: i.followUpId ? idOf(i.followUpId) : null,
    })),
  };
};

const followUpView = (f, names, c, today) => {
  const state = S.followUpState(f, today);
  return {
    id: idOf(f),
    item: f.item,
    relatedTo: f.relatedTo ?? '',
    ownerId: f.ownerId ? idOf(f.ownerId) : null,
    owner: (f.ownerId && names.get(idOf(f.ownerId))) || f.ownerName || '',
    department: f.department,
    dueDate: f.dueDate,
    status: f.status,
    state,
    daysAgo: state === 'overdue' ? T.daysBetween(f.dueDate, today) : 0,
    reminder: !!f.reminder,
    meetingId: f.meetingId ? idOf(f.meetingId) : null,
    brand: f.brand ?? 'main',
    doneAt: f.doneAt ?? null,
    canEdit: canChangeFollowUp(f, c),
    canDelete: c.manager || idOf(f.createdBy) === c.userId,
  };
};
const canChangeFollowUp = (f, c) => c.manager || idOf(f.createdBy) === c.userId || (!!c.ownId && idOf(f.ownerId) === c.ownId);
const followUpViews = async (list, c, today) => {
  const names = await memberNames(list.map((f) => f.ownerId));
  return list.map((f) => followUpView(f, names, c, today));
};

/**
 * A Team Dashboard task as a row of the task table (utils/marketingCoordinationStats.js taskAsRequest). It is changed where it lives —
 * the app moves its status through /api/marketing/team/tasks — so it carries the team's statuses, not the request ones.
 */
const taskRowView = (t, names, makers, c, today) => ({
  id: idOf(t),
  kind: 'task',
  title: t.title,
  detail: t.detail ?? '',
  fromDept: t.fromDept,
  toDept: t.toDept,
  requestedById: null,
  requestedBy: makers.get(idOf(t.createdBy)) ?? '',
  assigneeId: t.assigneeId ? idOf(t.assigneeId) : null,
  assignee: (t.assigneeId && names.get(idOf(t.assigneeId))) || '',
  priority: t.priority,
  dueDate: t.dueDate ?? null,
  status: t.status,
  taskStatus: t.taskStatus,
  progress: S.progressOf(t),
  brand: t.brand ?? 'main',
  stage: null,
  overdue: S.isOverdue(t, today),
  onTime: t.status === 'completed' && t.dueDate ? S.completedOnTime(t) : null,
  createdAt: t.createdAt,
  closedAt: t.closedAt ?? null,
  nextStatuses: [],
  taskStatuses: S.TEAM_TASK_STATUSES.filter((x) => x !== t.taskStatus),
  moveTo: [],
  link: '/marketing/team?tab=tasks',
  canEdit: c.manager || (!!c.ownId && idOf(t.assigneeId) === c.ownId),
  canDelete: false,
});

/** The table's rows — requests and team tasks together — each as its own view. */
const tableViews = async (list, c, today) => {
  const tasks = list.filter((r) => r.kind === 'task');
  const reqs = list.filter((r) => r.kind !== 'task');
  const names = await memberNames(list.flatMap((r) => [r.requestedById, r.assigneeId]));
  const makerIds = [...new Set(tasks.map((t) => idOf(t.createdBy)).filter((id) => mongoose.isValidObjectId(id)))];
  const makers = new Map(makerIds.length ? (await User.find({ _id: { $in: makerIds } }).select('name').lean()).map((u) => [idOf(u), u.name ?? '']) : []);
  const views = new Map([...reqs.map((r) => [idOf(r), requestView(r, names, c, today)]), ...tasks.map((t) => [idOf(t), taskRowView(t, names, makers, c, today)])]);
  return list.map((r) => views.get(idOf(r)));
};

// ── loading ───────────────────────────────────────────────────────────────────

/** The Team Dashboard's tasks that can count in [from, to] (the request rule: made in it, completed in it, or open from before it), as table rows. */
const loadTeamTasks = async (from, to, brand) => {
  const rows = await MarketingTask.find({
    ...brandQuery(brand),
    $or: [
      { createdAt: { $gte: istStart(from), $lt: istEnd(to) } },
      { completedAt: { $gte: istStart(from), $lt: istEnd(to) } },
      { status: { $ne: 'completed' }, createdAt: { $lt: istStart(from) } },
    ],
  })
    .limit(LIMIT_ROWS)
    .lean();
  return rows.map(S.taskAsRequest);
};

/** The requests that can count in [from, to]: logged in it, closed in it, or still open from before it. */
const loadRequests = (from, to, brand) =>
  CoordRequest.find({
    ...brandQuery(brand),
    status: { $ne: 'cancelled' },
    $or: [
      { createdAt: { $gte: istStart(from), $lt: istEnd(to) } },
      { closedAt: { $gte: istStart(from), $lt: istEnd(to) } },
      { status: { $in: S.OPEN_STATUSES }, createdAt: { $lt: istStart(from) } },
    ],
  })
    .limit(LIMIT_ROWS)
    .lean();

const loadApprovals = (from, to, brand) =>
  CoordApproval.find({
    ...brandQuery(brand),
    $or: [
      { createdAt: { $gte: istStart(from), $lt: istEnd(to) } },
      { decidedAt: { $gte: istStart(from), $lt: istEnd(to) } },
      { status: { $in: S.AWAITING_APPROVAL }, createdAt: { $lt: istStart(from) } },
    ],
  })
    .limit(LIMIT_ROWS)
    .lean();

/** Posts in review (Socials) and assets in review (Creative Portfolio): what is waiting for a decision elsewhere. Not date-limited — a review does not go away when the week moves on. */
const loadReviewQueue = async (brand, take = 6) => {
  const q = brandQuery(brand);
  const [content, assets, contentCount, assetCount] = await Promise.all([
    ContentItem.find({ status: 'in-review', ...q }).sort({ scheduledDate: 1 }).limit(30).select('title platform contentType brand scheduledDate thumbUrl status').lean(),
    MarketingAsset.find({ stage: 'in_review', ...q }).sort({ createdAt: 1 }).limit(30).select('title kind brand createdAt thumbUrl stage').lean(),
    ContentItem.countDocuments({ status: 'in-review', ...q }),
    MarketingAsset.countDocuments({ stage: 'in_review', ...q }),
  ]);
  return { total: contentCount + assetCount, content: contentCount, assets: assetCount, items: S.reviewQueue({ content, assets, brand }).slice(0, take) };
};

const scopeOf = (range) => ({ from: range.from, to: range.to, brand: range.brand, dept: range.dept });

// ── setup ─────────────────────────────────────────────────────────────────────

/** What the forms need: the departments, the team (with roles), who is asking and what they may do. */
export const getSetup = asyncHandler(async (req, res) => {
  const c = await whoIs(req);
  const month = toDateStr().slice(0, 7);
  const members = await MarketingTeamMember.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).select('name').lean();
  const roles = await MarketingMemberRole.find({ memberId: { $in: members.map((m) => m._id) }, fromMonth: { $lte: month } }).sort({ fromMonth: -1 }).populate('roleId').lean();
  const role = new Map();
  for (const r of roles) if (!role.has(idOf(r.memberId))) role.set(idOf(r.memberId), r.roleId?.name ?? '');
  const waiting = await CoordRequest.find({ status: 'pending_approval' }).sort({ createdAt: -1 }).limit(50).select('title').lean();
  res.json({
    departments: S.DEPARTMENTS,
    approvalCategories: S.APPROVAL_CATEGORIES,
    priorities: S.PRIORITIES,
    statuses: S.REQUEST_STATUSES.map((key) => ({ key, label: S.STATUS_LABEL[key] })),
    stages: S.HANDOVER_STAGES.map((s) => ({ key: s.key, label: s.label })),
    members: members.map((m) => ({ id: idOf(m), name: m.name, role: role.get(idOf(m)) ?? '' })),
    waitingRequests: waiting.map((r) => ({ id: idOf(r), title: r.title })), // requests waiting for approval: what an approval can be linked to
    me: { memberId: c.ownId || null, name: req.user.name ?? '', isManager: c.manager },
  });
});

// ── Overview ──────────────────────────────────────────────────────────────────

export const getOverview = asyncHandler(async (req, res) => {
  const range = readRange(req, res);
  const { today } = range;
  const by = ['requesting', 'receiving', 'both'].includes(req.query.by) ? req.query.by : 'both';
  const period = ['today', 'week', 'month'].includes(req.query.upcoming) ? req.query.upcoming : 'week';
  const until = S.periodEnd(today, period);
  const c = await whoIs(req);
  const scope = scopeOf(range);
  const prev = T.previousRange(range);
  const now = new Date();
  const q = brandQuery(range.brand);

  await sweepFollowUpReminders();
  // one window covers this period and the one before it (for the change on the tiles)
  const [requests, approvals, queue, meetings, dueRequests, nextMeeting, lateFollowUps, teamTasks] = await Promise.all([
    loadRequests(prev.from, range.to, range.brand),
    loadApprovals(prev.from, range.to, range.brand),
    loadReviewQueue(range.brand, 6),
    CoordMeeting.find({ ...q, status: 'upcoming', endAt: { $gte: now }, startAt: { $lt: istEnd(until) } }).sort({ startAt: 1 }).limit(100).lean(),
    CoordRequest.find({ ...q, status: { $in: S.OPEN_STATUSES }, dueDate: { $gte: today, $lte: until } }).limit(300).lean(),
    CoordMeeting.findOne({ ...q, status: 'upcoming', endAt: { $gte: now } }).sort({ startAt: 1 }).lean(),
    CoordFollowUp.find({ ...q, status: 'open', dueDate: { $lt: today } }).select('department').limit(1000).lean(),
    loadTeamTasks(range.from, range.to, range.brand),
  ]);

  const kpis = S.coordKpis({ requests, approvals, range: scope, today });
  const before = S.coordKpis({ requests, approvals, range: { ...scope, from: prev.from, to: prev.to }, today });
  const scoped = S.requestsInScope(requests, scope);
  const sorted = S.sortRequests(scoped);
  // the task table: the requests and the Team Dashboard's tasks together (one task record, read by both screens)
  const table = S.sortRequests([...scoped, ...S.requestsInScope(teamTasks, scope)]);
  const tabs = S.tabCounts(table, c.ownId);
  const tabRows = {};
  for (const tab of ['my', 'team', 'all']) tabRows[tab] = await tableViews(S.tabFilter(table, tab, c.ownId).slice(0, 5), c, today);

  const awaiting = S.approvalsInScope(approvals, scope).filter((a) => S.AWAITING_APPROVAL.includes(a.status)).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const handovers = sorted.filter((r) => r.kind === 'handover');
  const interDept = [...handovers.filter((r) => S.isOpenStatus(r.status)), ...handovers.filter((r) => r.status === 'completed')].slice(0, 6);
  const recent = [...scoped].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5);
  const lateCount = lateFollowUps.filter((f) => S.deptOk(range.dept, f.department)).length;
  const nextOne = nextMeeting && (range.dept === 'all' || (nextMeeting.departments ?? []).includes(range.dept)) ? nextMeeting : null;

  res.json({
    from: range.from,
    to: range.to,
    brand: range.brand,
    dept: range.dept,
    today,
    kpis,
    change: S.kpiChange(kpis, before),
    tabCounts: tabs,
    tasks: tabRows,
    byDepartment: S.departmentBreakdown(scoped, by),
    recent: await requestViews(recent, c, today),
    interDepartment: await requestViews(interDept, c, today),
    approvalsPending: {
      approvals: await approvalViews(awaiting.slice(0, 4), c, today),
      approvalCount: awaiting.length,
      review: queue,
    },
    upcoming: {
      period,
      items: S.upcomingItems({ meetings: meetings.filter((m) => range.dept === 'all' || (m.departments ?? []).includes(range.dept)), requests: dueRequests.filter((r) => S.deptOk(range.dept, r.fromDept, r.toDept)), now, today, until, limit: 8 }),
    },
    keyUpdates: S.keyUpdates({
      kpis,
      awaiting,
      nextMeeting: nextOne ? { title: nextOne.title, day: T.istDay(nextOne.startAt), time: S.istTime(nextOne.startAt) } : null,
      overdueFollowUps: lateCount,
      today,
    }),
  });
});

// ── Requests & Tasks ──────────────────────────────────────────────────────────

/** The request list a screen asks for: the scoped list (or the cancelled ones), narrowed by tab, status, priority, kind and search. */
const requestList = async (req, res, c) => {
  const range = readRange(req, res);
  const scope = scopeOf(range);
  const status = String(req.query.status ?? 'all');
  const priority = String(req.query.priority ?? 'all');
  const kind = String(req.query.kind ?? 'all');
  const tab = ['my', 'team', 'all'].includes(req.query.scope) ? req.query.scope : 'all';
  if (status !== 'all' && !['pending', 'overdue', ...S.REQUEST_STATUSES].includes(status)) bad(res, 'Unknown status.');
  if (priority !== 'all' && !S.PRIORITIES.includes(priority)) bad(res, 'Unknown priority.');
  if (!['all', 'request', 'handover', 'task'].includes(kind)) bad(res, 'Unknown kind.');

  const [loaded, teamTasks] = await Promise.all([loadRequests(range.from, range.to, range.brand), loadTeamTasks(range.from, range.to, range.brand)]);
  const scoped = S.requestsInScope(loaded, scope);
  // the table lists the Team Dashboard's tasks beside the requests (their figures stay out of the request strip)
  const table = [...scoped, ...S.requestsInScope(teamTasks, scope)];
  let base = table;
  if (status === 'cancelled') {
    const cancelled = await CoordRequest.find({ ...brandQuery(range.brand), status: 'cancelled', createdAt: { $gte: istStart(range.from), $lt: istEnd(range.to) } }).limit(LIMIT_ROWS).lean();
    base = cancelled.filter((r) => S.deptOk(range.dept, r.fromDept, r.toDept));
  }
  let list = S.tabFilter(base, tab, c.ownId);
  list = S.statusFilter(list, status === 'cancelled' ? 'all' : status, range.today);
  if (priority !== 'all') list = list.filter((r) => r.priority === priority);
  if (kind !== 'all') list = list.filter((r) => r.kind === kind);
  const text = String(req.query.q ?? '').trim().toLowerCase();
  if (text) {
    const names = await memberNames(list.flatMap((r) => [r.requestedById, r.assigneeId]));
    list = list.filter((r) => [r.title, r.detail, r.fromDept, r.toDept, r.assigneeName, r.requestedByName, names.get(idOf(r.requestedById)), names.get(idOf(r.assigneeId))].some((x) => (x ?? '').toLowerCase().includes(text)));
  }
  return { range, scoped, table, list: S.sortRequests(list) };
};

export const listRequests = asyncHandler(async (req, res) => {
  const c = await whoIs(req);
  const { range, scoped, table, list } = await requestList(req, res, c);
  const { page, limit } = pageOf(req);
  res.json({
    from: range.from,
    to: range.to,
    brand: range.brand,
    dept: range.dept,
    kpis: S.coordKpis({ requests: scoped, range: scopeOf(range), today: range.today, includeApprovals: false }),
    tabCounts: S.tabCounts(table, c.ownId),
    teamTasks: table.length - scoped.length,
    total: list.length,
    page,
    pageSize: limit,
    items: await tableViews(list.slice((page - 1) * limit, page * limit), c, range.today),
  });
});

/** Who the request is raised for and who it is given to, checked against the team. */
const resolvePeople = async (req, res, v, c, existing = null) => {
  const out = {};
  if (v.requestedById !== undefined) {
    const current = existing ? idOf(existing.requestedById) : c.ownId;
    const wanted = v.requestedById ?? '';
    if (wanted !== current && !(!existing && wanted === '') && !c.manager) bad(res, 'Only the Marketing Manager or Admin can raise a request for someone else.', 403);
    if (v.requestedById) await needMember(res, v.requestedById, 'requester');
    out.requestedById = v.requestedById;
  }
  let assignee = null;
  if (v.assigneeId !== undefined) {
    if (v.assigneeId) assignee = await needMember(res, v.assigneeId, 'assignee');
    out.assigneeId = v.assigneeId;
    if (v.assigneeId) out.assigneeName = '';
  }
  return { ...out, assignee };
};

const notifyAssigned = async (r, member, user) => {
  if (!member?.userId) return;
  await notify({
    recipients: [member.userId],
    type: NOTIFICATION_TYPES.COORD_REQUEST,
    title: r.kind === 'handover' ? 'New handover for you' : 'New request for you',
    body: `${r.title} (${r.fromDept} → ${r.toDept})${r.dueDate ? ` — due ${r.dueDate}` : ''}`,
    link: '/marketing/coordinations?tab=requests',
    createdBy: user._id,
    excludeUserId: user._id,
  });
};

/** Move a request to [next]: closed days, progress and the closing moment follow the status. */
const applyStatus = (r, next, { keepProgress = false } = {}) => {
  if (!next || next === r.status) return;
  if (!keepProgress) r.progress = S.progressAfterMove(r.status, next, r.progress);
  r.closedAt = next === 'completed' || next === 'cancelled' ? new Date() : null;
  r.status = next;
  if (next === 'completed') r.progress = 100;
};

export const createRequest = asyncHandler(async (req, res) => {
  const c = await whoIs(req);
  const v = cleanRequestInput(req.body);
  if (!v.ok) bad(res, v.message, 400);
  const { assignee, ...people } = await resolvePeople(req, res, v.value, c);
  const { status, requestedById, assigneeId, ...fields } = v.value;
  void requestedById;
  void assigneeId;
  const r = await CoordRequest.create({
    ...fields,
    ...people,
    requestedById: people.requestedById ?? (c.own ? c.own._id : null),
    requestedByName: people.requestedById || c.own ? '' : (req.user.name ?? ''),
    status: status ?? 'open',
    progress: fields.progress ?? S.progressAfterMove('open', status ?? 'open', 0),
    createdBy: req.user._id,
    lastEditedBy: req.user._id,
  });
  await notifyAssigned(r, assignee, req.user);
  res.status(201).json((await requestViews([r.toObject()], c, toDateStr()))[0]);
});

const findRequest = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) bad(res, 'That request was not found.', 404);
  const r = await CoordRequest.findById(req.params.id);
  if (!r) bad(res, 'That request was not found.', 404);
  return r;
};

export const updateRequest = asyncHandler(async (req, res) => {
  const c = await whoIs(req);
  const r = await findRequest(req, res);
  if (!canChangeRequest(r, c)) bad(res, 'You can change the requests you raised or were given. Ask the Marketing Manager for others.', 403);
  const v = cleanRequestInput(req.body, r.toObject());
  if (!v.ok) bad(res, v.message, 400);
  const people = await resolvePeople(req, res, v.value, c, r);
  const { status, requestedById, assigneeId, ...fields } = v.value;
  void requestedById;
  void assigneeId;
  const reassigned = people.assigneeId !== undefined && idOf(people.assigneeId) !== idOf(r.assigneeId);
  const { assignee, ...peopleFields } = people;
  Object.assign(r, fields, peopleFields, { lastEditedBy: req.user._id });
  if (peopleFields.requestedById !== undefined && peopleFields.requestedById) r.requestedByName = '';
  applyStatus(r, status, { keepProgress: fields.progress !== undefined });
  if (status === 'completed') r.progress = 100;
  await r.save();
  if (reassigned) await notifyAssigned(r, assignee, req.user);
  res.json((await requestViews([r.toObject()], c, toDateStr()))[0]);
});

/** The Inter-Department board's move: a handover goes to another stage. */
export const moveRequest = asyncHandler(async (req, res) => {
  const c = await whoIs(req);
  const r = await findRequest(req, res);
  if (!canChangeRequest(r, c)) bad(res, 'You can move the handovers you raised or were given. Ask the Marketing Manager for others.', 403);
  const next = S.statusForStage(String(req.body?.stage ?? ''));
  if (!next) bad(res, 'Choose Requested, In Progress, In Review or Completed.', 400);
  if (r.status === 'cancelled') bad(res, 'A cancelled request has to be reopened first.', 409);
  if (S.handoverStage(r.status) !== String(req.body.stage)) {
    if (!S.canMoveRequest(r.status, next)) bad(res, `A request that is ${S.STATUS_LABEL[r.status]} cannot be moved to ${S.STATUS_LABEL[next]}.`, 400);
    applyStatus(r, next);
    r.lastEditedBy = req.user._id;
    await r.save();
  }
  res.json((await requestViews([r.toObject()], c, toDateStr()))[0]);
});

export const deleteRequest = asyncHandler(async (req, res) => {
  const c = await whoIs(req);
  const r = await findRequest(req, res);
  if (!c.manager && idOf(r.createdBy) !== c.userId) bad(res, 'Only the person who raised a request, or the Marketing Manager, can delete it. Cancel it instead.', 403);
  await CoordApproval.updateMany({ requestId: r._id }, { $set: { requestId: null } });
  await r.deleteOne();
  res.json({ message: 'Request deleted' });
});

// ── Inter-Department ──────────────────────────────────────────────────────────

export const getInterDepartment = asyncHandler(async (req, res) => {
  const range = readRange(req, res);
  const c = await whoIs(req);
  const loaded = await loadRequests(range.from, range.to, range.brand);
  const handovers = S.requestsInScope(loaded, scopeOf(range)).filter((r) => r.kind === 'handover');
  const columns = S.handoverColumns(handovers);
  const stages = [];
  for (const col of columns) stages.push({ key: col.key, label: col.label, count: col.count, items: await requestViews(col.items.slice(0, 50), c, range.today) });
  res.json({ from: range.from, to: range.to, brand: range.brand, dept: range.dept, kpis: S.handoverKpis(handovers, range.today), stages });
});

// ── Approvals ─────────────────────────────────────────────────────────────────

const findApproval = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) bad(res, 'That approval was not found.', 404);
  const a = await CoordApproval.findById(req.params.id);
  if (!a) bad(res, 'That approval was not found.', 404);
  return a;
};

export const listApprovals = asyncHandler(async (req, res) => {
  const range = readRange(req, res);
  const c = await whoIs(req);
  const tab = String(req.query.status ?? 'pending');
  if (tab !== 'all' && !['pending', 'in_review', 'approved', 'rejected'].includes(tab)) bad(res, 'Choose Pending, In Review, Approved or Rejected.');
  const loaded = await loadApprovals(range.from, range.to, range.brand);
  const scoped = S.approvalsInScope(loaded, scopeOf(range));
  let list = tab === 'all' ? scoped : scoped.filter((a) => S.approvalTab(a.status) === tab);
  const text = String(req.query.q ?? '').trim().toLowerCase();
  if (text) {
    const names = await memberNames(list.map((a) => a.requestedById));
    list = list.filter((a) => [a.title, a.category, a.impact, a.requestedByName, names.get(idOf(a.requestedById))].some((x) => (x ?? '').toLowerCase().includes(text)));
  }
  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const { page, limit } = pageOf(req);
  res.json({
    from: range.from,
    to: range.to,
    brand: range.brand,
    dept: range.dept,
    kpis: S.approvalKpis(scoped),
    tabCounts: S.approvalTabCounts(scoped),
    total: list.length,
    page,
    pageSize: limit,
    items: await approvalViews(list.slice((page - 1) * limit, page * limit), c, range.today),
    review: await loadReviewQueue(range.brand, 20),
  });
});

export const getReviewQueue = asyncHandler(async (req, res) => {
  const range = readRange(req, res);
  res.json(await loadReviewQueue(range.brand, 30));
});

export const createApproval = asyncHandler(async (req, res) => {
  const c = await whoIs(req);
  const v = cleanApprovalInput(req.body);
  if (!v.ok) bad(res, v.message, 400);
  const { requestedById, requestId, ...fields } = v.value;
  if (requestedById && requestedById !== c.ownId && !c.manager) bad(res, 'Only the Marketing Manager or Admin can raise an approval for someone else.', 403);
  if (requestedById) await needMember(res, requestedById, 'requester');
  if (requestId && !(await CoordRequest.exists({ _id: requestId }))) bad(res, 'That request no longer exists.', 400);
  const a = await CoordApproval.create({
    ...fields,
    requestId: requestId ?? null,
    requestedById: requestedById ?? (c.own ? c.own._id : null),
    requestedByName: c.own || requestedById ? '' : (req.user.name ?? ''),
    createdBy: req.user._id,
  });
  res.status(201).json((await approvalViews([a.toObject()], c, toDateStr()))[0]);
});

export const updateApproval = asyncHandler(async (req, res) => {
  const c = await whoIs(req);
  const a = await findApproval(req, res);
  if (!S.AWAITING_APPROVAL.includes(a.status)) bad(res, `This approval is already ${a.status}. Raise a new one if something changed.`, 409);
  const mine = idOf(a.createdBy) === c.userId || (!!c.ownId && idOf(a.requestedById) === c.ownId);
  if (!c.manager && !(mine && a.status === 'pending')) bad(res, 'You can change your own approval until it is being reviewed. Ask the Marketing Manager.', 403);
  const v = cleanApprovalInput(req.body, a.toObject());
  if (!v.ok) bad(res, v.message, 400);
  const { requestedById, requestId, ...fields } = v.value;
  if (requestedById !== undefined && !c.manager) bad(res, 'Only the Marketing Manager or Admin can change who raised an approval.', 403);
  if (requestedById) await needMember(res, requestedById, 'requester');
  if (requestId && !(await CoordRequest.exists({ _id: requestId }))) bad(res, 'That request no longer exists.', 400);
  Object.assign(a, fields);
  if (requestId !== undefined) a.requestId = requestId;
  if (requestedById !== undefined) {
    a.requestedById = requestedById;
    a.requestedByName = '';
  }
  await a.save();
  res.json((await approvalViews([a.toObject()], c, toDateStr()))[0]);
});

export const deleteApproval = asyncHandler(async (req, res) => {
  const c = await whoIs(req);
  const a = await findApproval(req, res);
  if (!c.manager && !(a.status === 'pending' && idOf(a.createdBy) === c.userId)) bad(res, 'You can withdraw your own approval while it is still pending. Ask the Marketing Manager otherwise.', 403);
  await a.deleteOne();
  res.json({ message: 'Approval deleted' });
});

/**
 * Who an escalation goes up to: the active leadership logins (CEO, Executive Director) and the Marketing Managers, minus the person
 * escalating. → [{ userId, name, title }] (leadership first). Admin logins are never told operational news (utils/notify.js), so they
 * are not listed either.
 */
const escalationTargets = async (actorId) => {
  const leaders = await User.find({ role: { $in: LEADERSHIP_ROLES }, active: { $ne: false } }).select('name role').lean();
  const managerIds = await managerUserIds();
  const leaderIds = new Set(leaders.map((u) => idOf(u)));
  const managers = managerIds.length ? await User.find({ _id: { $in: managerIds.filter((id) => !leaderIds.has(String(id))) }, role: { $ne: 'admin' }, active: { $ne: false } }).select('name').lean() : [];
  const actor = idOf(actorId);
  return [
    ...leaders.map((u) => ({ userId: u._id, name: u.name ?? '', title: leadershipTitle(u.role) })),
    ...managers.map((u) => ({ userId: u._id, name: u.name ?? '', title: 'Marketing Manager' })),
  ].filter((p) => idOf(p.userId) !== actor);
};

/** Only a Marketing Manager / admin decides: review, approve, reject (with a note) or escalate. Nothing is posted to accounts. */
export const decideApproval = asyncHandler(async (req, res) => {
  const c = await whoIs(req);
  if (!c.manager) bad(res, 'Only the Marketing Manager or Admin can decide an approval.', 403);
  const a = await findApproval(req, res);
  const v = cleanDecisionInput(req.body);
  if (!v.ok) bad(res, v.message, 400);
  const next = S.approvalNext(a.status, v.value.decision);
  if (!next) {
    const word = a.status === 'in_review' ? 'in review' : a.status;
    bad(res, S.AWAITING_APPROVAL.includes(a.status) ? `This approval is already ${word}.` : `This approval is already ${word}, so it is final. Raise a new one if something changed.`, 409);
  }
  const now = new Date();
  a.status = next;
  if (next === 'approved' || next === 'rejected') {
    a.decidedAt = now;
    a.decidedBy = req.user._id;
    a.decidedByName = req.user.name ?? '';
    a.decisionNote = v.value.note;
  } else if (next === 'escalated') {
    a.escalatedAt = now;
    if (v.value.note) a.decisionNote = v.value.note;
    // sent UP: the leadership (CEO / Executive Director) and the Marketing Managers — whoever escalated it is not told about their own act
    const to = await escalationTargets(req.user._id);
    a.escalatedTo = to;
    a.escalatedBy = req.user._id;
    a.escalatedByName = req.user.name ?? '';
  }
  await a.save();
  if (next === 'escalated' && a.escalatedTo.length) {
    await notify({
      recipients: a.escalatedTo.map((p) => p.userId),
      type: NOTIFICATION_TYPES.COORD_APPROVAL,
      title: 'Approval escalated to you',
      body: `${a.title}${a.amount ? ` — ₹${Number(a.amount).toLocaleString('en-IN')}` : ''}${a.escalatedByName ? ` (escalated by ${a.escalatedByName})` : ''}${v.value.note ? ` — ${v.value.note}` : ''}`,
      link: '/marketing/coordinations?tab=approvals',
      createdBy: req.user._id,
      excludeUserId: req.user._id,
    });
  }

  // approved: the request that was waiting on it can move on
  if (next === 'approved' && a.requestId) {
    const r = await CoordRequest.findById(a.requestId);
    if (r && r.status === 'pending_approval') {
      applyStatus(r, 'in_progress');
      await r.save();
    }
  }
  if (next !== 'in_review' && a.requestedById) {
    const member = await MarketingTeamMember.findById(a.requestedById).select('userId').lean();
    if (member?.userId) {
      const word = { approved: 'approved', rejected: 'rejected', escalated: 'escalated' }[next];
      await notify({
        recipients: [member.userId],
        type: NOTIFICATION_TYPES.COORD_APPROVAL,
        title: `Approval ${word}`,
        body: `${a.title}${v.value.note ? ` — ${v.value.note}` : ''}`,
        link: '/marketing/coordinations?tab=approvals',
        createdBy: req.user._id,
        excludeUserId: req.user._id,
      });
    }
  }
  res.json((await approvalViews([a.toObject()], c, toDateStr()))[0]);
});

// ── Meetings ──────────────────────────────────────────────────────────────────

const findMeeting = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) bad(res, 'That meeting was not found.', 404);
  const m = await CoordMeeting.findById(req.params.id);
  if (!m) bad(res, 'That meeting was not found.', 404);
  return m;
};

export const listMeetings = asyncHandler(async (req, res) => {
  const range = readRange(req, res);
  const c = await whoIs(req);
  const now = new Date();
  const week = S.weekRange(range.today);
  const lo = range.from < week.from ? range.from : week.from;
  const hi = range.to > week.to ? range.to : week.to;
  const all = await CoordMeeting.find({ ...brandQuery(range.brand), startAt: { $gte: istStart(lo), $lt: istEnd(hi) } }).sort({ startAt: 1 }).limit(LIMIT_ROWS).lean();
  const kpis = S.meetingKpis(all, scopeOf(range), { today: range.today, now });
  let list = S.meetingsInRange(all, scopeOf(range));
  const status = String(req.query.status ?? 'all');
  if (status !== 'all') {
    if (!['upcoming', 'completed', 'to_close'].includes(status)) bad(res, 'Choose upcoming, completed or to close.');
    list = list.filter((m) => (status === 'upcoming' ? ['upcoming', 'live'].includes(S.meetingState(m, now)) : S.meetingState(m, now) === status));
  }
  const text = String(req.query.q ?? '').trim().toLowerCase();
  if (text) list = list.filter((m) => [m.title, m.location, ...(m.departments ?? [])].some((x) => (x ?? '').toLowerCase().includes(text)));
  res.json({ from: range.from, to: range.to, brand: range.brand, dept: range.dept, kpis, total: list.length, items: list.slice(0, 200).map((m) => meetingBrief(m, now, c)) });
});

export const getMeeting = asyncHandler(async (req, res) => {
  const c = await whoIs(req);
  const m = await findMeeting(req, res);
  res.json(await meetingDetail(m.toObject(), new Date(), c));
});

const checkAttendees = async (res, attendees) => {
  const ids = (attendees ?? []).map((a) => a.memberId).filter(Boolean);
  if (!ids.length) return;
  const found = await MarketingTeamMember.countDocuments({ _id: { $in: ids } });
  if (found !== new Set(ids).size) bad(res, 'An attendee is not on the team.', 400);
};

/** The action items after an update: an item kept by id keeps its follow-up (which then owns its done state). */
const reconcileItems = (meeting, incoming) => {
  const byId = new Map(meeting.actionItems.map((i) => [idOf(i), i]));
  return incoming.map((it) => {
    const old = it.id ? byId.get(it.id) : null;
    if (!old) return { text: it.text, ownerId: it.ownerId, ownerName: it.ownerName, due: it.due, done: it.done };
    old.text = it.text;
    old.ownerId = it.ownerId;
    old.ownerName = it.ownerName;
    old.due = it.due;
    if (!old.followUpId) old.done = it.done;
    return old;
  });
};

export const createMeeting = asyncHandler(async (req, res) => {
  const c = await whoIs(req);
  const v = cleanMeetingInput(req.body);
  if (!v.ok) bad(res, v.message, 400);
  const { actionItems, status, ...fields } = v.value;
  await checkAttendees(res, fields.attendees);
  if (status === 'completed' && fields.startAt > new Date()) bad(res, 'A meeting that has not started cannot be marked completed.', 400);
  const m = await CoordMeeting.create({
    ...fields,
    status: status ?? 'upcoming',
    completedAt: status === 'completed' ? new Date() : null,
    actionItems: (actionItems ?? []).map((i) => ({ text: i.text, ownerId: i.ownerId, ownerName: i.ownerName, due: i.due, done: i.done })),
    createdBy: req.user._id,
  });
  res.status(201).json(await meetingDetail(m.toObject(), new Date(), c));
});

export const updateMeeting = asyncHandler(async (req, res) => {
  const c = await whoIs(req);
  const m = await findMeeting(req, res);
  if (!canChangeMeeting(m, c)) bad(res, 'You can change the meetings you set up or attend. Ask the Marketing Manager for others.', 403);
  const v = cleanMeetingInput(req.body, m.toObject());
  if (!v.ok) bad(res, v.message, 400);
  const { actionItems, status, ...fields } = v.value;
  await checkAttendees(res, fields.attendees);
  const start = fields.startAt ?? m.startAt;
  if (status === 'completed' && status !== m.status && new Date(start) > new Date()) bad(res, 'A meeting that has not started cannot be marked completed.', 400);
  Object.assign(m, fields);
  if (actionItems) m.actionItems = reconcileItems(m, actionItems);
  if (status && status !== m.status) {
    m.status = status;
    m.completedAt = status === 'completed' ? new Date() : null;
  }
  await m.save();
  res.json(await meetingDetail(m.toObject(), new Date(), c));
});

export const deleteMeeting = asyncHandler(async (req, res) => {
  const c = await whoIs(req);
  const m = await findMeeting(req, res);
  if (!c.manager && idOf(m.createdBy) !== c.userId) bad(res, 'Only the person who set a meeting up, or the Marketing Manager, can delete it. Cancel it instead.', 403);
  await CoordFollowUp.updateMany({ meetingId: m._id }, { $set: { meetingId: null, meetingItemId: null } });
  await m.deleteOne();
  res.json({ message: 'Meeting deleted' });
});

/** An action item becomes a follow-up: it is then tracked in Follow-ups, and that record decides whether it is done. */
export const actionItemToFollowUp = asyncHandler(async (req, res) => {
  const c = await whoIs(req);
  const m = await findMeeting(req, res);
  if (!canChangeMeeting(m, c)) bad(res, 'You can change the meetings you set up or attend. Ask the Marketing Manager for others.', 403);
  if (!mongoose.isValidObjectId(req.params.itemId)) bad(res, 'That action item was not found.', 404);
  const item = m.actionItems.id(req.params.itemId);
  if (!item) bad(res, 'That action item was not found.', 404);
  if (item.followUpId && (await CoordFollowUp.exists({ _id: item.followUpId }))) bad(res, 'That action item is already a follow-up.', 409);
  if (item.done) bad(res, 'That action item is already done.', 409);
  if (!item.due) bad(res, 'Give the action item a due date first, then make it a follow-up.', 400);
  const f = await CoordFollowUp.create({
    item: item.text,
    relatedTo: m.title,
    ownerId: item.ownerId ?? null,
    ownerName: item.ownerName ?? '',
    department: (m.departments ?? [])[0] ?? 'Marketing',
    dueDate: item.due,
    reminder: true,
    meetingId: m._id,
    meetingItemId: item._id,
    brand: m.brand,
    createdBy: req.user._id,
  });
  item.followUpId = f._id;
  await m.save();
  res.status(201).json({ followUp: (await followUpViews([f.toObject()], c, toDateStr()))[0], meeting: await meetingDetail(m.toObject(), new Date(), c) });
});

// ── Follow-ups ────────────────────────────────────────────────────────────────

const findFollowUp = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) bad(res, 'That follow-up was not found.', 404);
  const f = await CoordFollowUp.findById(req.params.id);
  if (!f) bad(res, 'That follow-up was not found.', 404);
  return f;
};

const readOwner = (req, res) => {
  const ownerId = req.query.ownerId ? String(req.query.ownerId) : '';
  if (ownerId && !mongoose.isValidObjectId(ownerId)) bad(res, 'Unknown owner.');
  return ownerId;
};

export const listFollowUps = asyncHandler(async (req, res) => {
  const range = readRange(req, res);
  await sweepFollowUpReminders(); // the reminders that are due go out on a read too, so they never wait for a scheduler
  const c = await whoIs(req);
  const ownerId = readOwner(req, res);
  const { today } = range;
  const q = brandQuery(range.brand);
  const loaded = await CoordFollowUp.find({ ...q, $or: [{ dueDate: { $gte: range.from, $lte: range.to } }, { status: 'open', dueDate: { $lt: range.from } }] }).limit(LIMIT_ROWS).lean();
  const scope = { ...scopeOf(range), ownerId };
  const scoped = S.followUpsInScope(loaded, scope, today);
  const status = String(req.query.status ?? 'all');
  if (status !== 'all' && !['due_today', 'upcoming', 'overdue', 'completed'].includes(status)) bad(res, 'Choose due today, upcoming, overdue or completed.');
  let list = status === 'all' ? scoped : scoped.filter((f) => S.followUpState(f, today) === status);
  const text = String(req.query.q ?? '').trim().toLowerCase();
  if (text) list = list.filter((f) => [f.item, f.relatedTo, f.ownerName, f.department].some((x) => (x ?? '').toLowerCase().includes(text)));
  list.sort((a, b) => (a.status === b.status ? (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0) : a.status === 'done' ? 1 : -1));
  // the overdue panel is every open follow-up past its day, whatever the range
  const lateAll = await CoordFollowUp.find({ ...q, status: 'open', dueDate: { $lt: today } }).limit(LIMIT_ROWS).lean();
  const late = S.overdueFollowUps(S.followUpsInScope(lateAll, { from: '0000-01-01', to: today, brand: range.brand, dept: range.dept, ownerId }, today), today);
  const { page, limit } = pageOf(req);
  res.json({
    from: range.from,
    to: range.to,
    brand: range.brand,
    dept: range.dept,
    today,
    kpis: S.followUpKpis(scoped, today),
    total: list.length,
    page,
    pageSize: limit,
    items: await followUpViews(list.slice((page - 1) * limit, page * limit), c, today),
    overdue: { total: late.length, items: await followUpViews(late.slice(0, 20), c, today) },
  });
});

export const getFollowUpCalendar = asyncHandler(async (req, res) => {
  const range = readRange(req, res);
  const month = String(req.query.month ?? range.today.slice(0, 7));
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) bad(res, 'The month must look like 2026-11.');
  const ownerId = readOwner(req, res);
  const first = `${month}-01`;
  const last = S.monthEnd(first);
  const list = await CoordFollowUp.find({ ...brandQuery(range.brand), dueDate: { $gte: first, $lte: last } }).limit(LIMIT_ROWS).lean();
  const shown = list.filter((f) => S.deptOk(range.dept, f.department) && (!ownerId || idOf(f.ownerId) === ownerId));
  res.json({ month, today: range.today, days: S.calendarDays(shown, range.today) });
});

export const createFollowUp = asyncHandler(async (req, res) => {
  const c = await whoIs(req);
  const v = cleanFollowUpInput(req.body);
  if (!v.ok) bad(res, v.message, 400);
  const { ownerId, meetingId, status, ...fields } = v.value;
  if (ownerId) await needMember(res, ownerId, 'owner');
  if (meetingId && !(await CoordMeeting.exists({ _id: meetingId }))) bad(res, 'That meeting no longer exists.', 400);
  const f = await CoordFollowUp.create({
    ...fields,
    status: status ?? 'open',
    doneAt: status === 'done' ? new Date() : null,
    ownerId: ownerId === undefined ? (c.own ? c.own._id : null) : ownerId,
    meetingId: meetingId ?? null,
    createdBy: req.user._id,
  });
  res.status(201).json((await followUpViews([f.toObject()], c, toDateStr()))[0]);
});

export const updateFollowUp = asyncHandler(async (req, res) => {
  const c = await whoIs(req);
  const f = await findFollowUp(req, res);
  if (!canChangeFollowUp(f, c)) bad(res, 'You can change the follow-ups you made or own. Ask the Marketing Manager for others.', 403);
  const v = cleanFollowUpInput(req.body, f.toObject());
  if (!v.ok) bad(res, v.message, 400);
  const { ownerId, meetingId, status, ...fields } = v.value;
  if (ownerId) await needMember(res, ownerId, 'owner');
  if (meetingId && !(await CoordMeeting.exists({ _id: meetingId }))) bad(res, 'That meeting no longer exists.', 400);
  Object.assign(f, fields);
  if (ownerId !== undefined) {
    f.ownerId = ownerId;
    if (ownerId) f.ownerName = '';
  }
  if (meetingId !== undefined) f.meetingId = meetingId;
  if (status && status !== f.status) {
    f.status = status;
    f.doneAt = status === 'done' ? new Date() : null;
  }
  await f.save();
  res.json((await followUpViews([f.toObject()], c, toDateStr()))[0]);
});

export const deleteFollowUp = asyncHandler(async (req, res) => {
  const c = await whoIs(req);
  const f = await findFollowUp(req, res);
  if (!c.manager && idOf(f.createdBy) !== c.userId) bad(res, 'Only the person who made a follow-up, or the Marketing Manager, can delete it.', 403);
  // a meeting's action item that became this follow-up is a plain action item again
  if (f.meetingId && f.meetingItemId) await CoordMeeting.updateOne({ _id: f.meetingId, 'actionItems._id': f.meetingItemId }, { $set: { 'actionItems.$.followUpId': null } });
  await f.deleteOne();
  res.json({ message: 'Follow-up deleted' });
});

// ── Export ────────────────────────────────────────────────────────────────────

const TEAM_TASK_LABEL = { not_started: 'Not started', in_progress: 'In progress', pending: 'Pending', blocked: 'Blocked', completed: 'Completed' };
const EXPORTS = ['overview', 'requests', 'approvals', 'meetings', 'followups'];

/** Rows for the CSV / print of a tab — the same scoped records the screen shows, all of them (not a page). */
export const getExport = asyncHandler(async (req, res) => {
  const type = req.params.type;
  if (!EXPORTS.includes(type)) bad(res, 'Unknown report.', 404);
  const range = readRange(req, res);
  const c = await whoIs(req);
  const { today } = range;
  const scope = scopeOf(range);
  let title;
  let columns;
  let rows;
  if (type === 'overview') {
    // the Overview's own figures, as the tab shows them: the headline strip, the department split, what is waiting and what is coming up
    const prev = T.previousRange(range);
    const until = S.periodEnd(today, 'month');
    const now = new Date();
    const [requests, approvals, meetings, dueRequests] = await Promise.all([
      loadRequests(prev.from, range.to, range.brand),
      loadApprovals(prev.from, range.to, range.brand),
      CoordMeeting.find({ ...brandQuery(range.brand), status: 'upcoming', endAt: { $gte: now }, startAt: { $lt: istEnd(until) } }).sort({ startAt: 1 }).limit(100).lean(),
      CoordRequest.find({ ...brandQuery(range.brand), status: { $in: S.OPEN_STATUSES }, dueDate: { $gte: today, $lte: until } }).limit(300).lean(),
    ]);
    const k = S.coordKpis({ requests, approvals, range: scope, today });
    const ch = S.kpiChange(k, S.coordKpis({ requests, approvals, range: { ...scope, from: prev.from, to: prev.to }, today }));
    const scoped = S.requestsInScope(requests, scope);
    const awaiting = S.approvalsInScope(approvals, scope).filter((a) => S.AWAITING_APPROVAL.includes(a.status));
    const pctText = (n) => (n == null ? '—' : `${n}%`);
    title = `Coordinations overview — ${range.from} to ${range.to}`;
    columns = ['Section', 'Item', 'Value', 'Note'];
    rows = [
      ['Headline', 'Total requests & approvals', k.total, ch.total == null ? '' : `${ch.total >= 0 ? '+' : ''}${ch.total}% vs the period before`],
      ['Headline', 'Completed', k.completed, ch.completed == null ? '' : `${ch.completed >= 0 ? '+' : ''}${ch.completed}% vs the period before`],
      ['Headline', 'In progress', k.inProgress, ''],
      ['Headline', 'Pending', k.pending, ''],
      ['Headline', 'Pending approvals', k.pendingApprovals, ''],
      ['Headline', 'Overdue', k.overdue, ''],
      ['Headline', 'On-time rate', pctText(k.onTimeRate), k.onTimeOf ? `of ${k.onTimeOf} with a due date` : 'nothing closed with a due date'],
      ...S.departmentBreakdown(scoped, 'both').rows.map((r) => ['Requests by department', r.label, r.count, `${r.pct}%`]),
      ...awaiting.map((a) => ['Waiting for approval', a.title, a.amount ?? 0, `${a.status}${a.dueDate ? `, needed by ${a.dueDate}` : ''}`]),
      ...S.upcomingItems({ meetings: meetings.filter((m) => range.dept === 'all' || (m.departments ?? []).includes(range.dept)), requests: dueRequests.filter((r) => S.deptOk(range.dept, r.fromDept, r.toDept)), now, today, until, limit: 50 }).map((u) => ['Upcoming', u.title, u.day, [u.time, u.subtitle].filter(Boolean).join(' · ')]),
    ];
  } else if (type === 'requests') {
    req.query.scope = req.query.scope ?? 'all';
    const { list } = await requestList(req, res, c);
    const views = await tableViews(list, c, today);
    title = `Coordination requests — ${range.from} to ${range.to}`;
    columns = ['Request', 'Type', 'Requested by', 'From', 'To', 'Assignee', 'Priority', 'Due date', 'Status', 'Progress %', 'Logged on', 'Closed on'];
    rows = views.map((r) => [r.title, r.kind === 'task' ? 'Team task' : r.kind === 'handover' ? 'Handover' : 'Request', r.requestedBy, r.fromDept, r.toDept, r.assignee, r.priority, r.dueDate ?? '', r.kind === 'task' ? TEAM_TASK_LABEL[r.taskStatus] ?? S.STATUS_LABEL[r.status] : S.STATUS_LABEL[r.status], r.progress, r.createdAt ? T.istDay(r.createdAt) : '', r.closedAt ? T.istDay(r.closedAt) : '']);
  } else if (type === 'approvals') {
    const scoped = S.approvalsInScope(await loadApprovals(range.from, range.to, range.brand), scope).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const views = await approvalViews(scoped, c, today);
    title = `Approvals — ${range.from} to ${range.to}`;
    columns = ['Approval', 'Category', 'Requested by', 'Amount (INR)', 'Impact', 'Needed by', 'Requested on', 'Status', 'Decided by', 'Decided on', 'Escalated to', 'Note'];
    rows = views.map((a) => [a.title, a.category, a.requestedBy, a.amount, a.impact, a.dueDate ?? '', a.requestedOn ?? '', a.status, a.decidedBy, a.decidedAt ? T.istDay(a.decidedAt) : '', a.escalatedToLabel.replace(/^Escalated to /, ''), a.decisionNote]);
  } else if (type === 'meetings') {
    const all = await CoordMeeting.find({ ...brandQuery(range.brand), startAt: { $gte: istStart(range.from), $lt: istEnd(range.to) } }).sort({ startAt: 1 }).limit(LIMIT_ROWS).lean();
    const list = S.meetingsInRange(all, scope);
    const names = await memberNames(list.flatMap((m) => (m.attendees ?? []).map((a) => a.memberId)));
    const now = new Date();
    title = `Meetings — ${range.from} to ${range.to}`;
    columns = ['Meeting', 'Date', 'Start', 'End', 'Where', 'Departments', 'Status', 'Attendees', 'Action items', 'Open action items'];
    rows = list.map((m) => [m.title, T.istDay(m.startAt), S.istTime(m.startAt), S.istTime(m.endAt), m.location || m.link || '', (m.departments ?? []).join('; '), S.meetingState(m, now), (m.attendees ?? []).map((a) => (a.memberId && names.get(idOf(a.memberId))) || a.name).filter(Boolean).join('; '), (m.actionItems ?? []).length, (m.actionItems ?? []).filter((i) => !i.done && !i.followUpId).length]);
  } else {
    const ownerId = readOwner(req, res);
    const loaded = await CoordFollowUp.find({ ...brandQuery(range.brand), $or: [{ dueDate: { $gte: range.from, $lte: range.to } }, { status: 'open', dueDate: { $lt: range.from } }] }).limit(LIMIT_ROWS).lean();
    const list = S.followUpsInScope(loaded, { ...scope, ownerId }, today).sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));
    const views = await followUpViews(list, c, today);
    title = `Follow-ups — ${range.from} to ${range.to}`;
    columns = ['Follow-up', 'Related to', 'Owner', 'Department', 'Due date', 'State', 'Reminder', 'Done on'];
    rows = views.map((f) => [f.item, f.relatedTo, f.owner, f.department, f.dueDate, f.state, f.reminder ? 'Yes' : 'No', f.doneAt ? T.istDay(f.doneAt) : '']);
  }
  res.json({ type, title, from: range.from, to: range.to, brand: range.brand, dept: range.dept, generatedAt: new Date(), columns, rows });
});

