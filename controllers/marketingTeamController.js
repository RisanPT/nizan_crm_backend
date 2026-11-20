import mongoose from 'mongoose';
import MarketingActivity from '../models/MarketingActivity.js';
import MarketingTask from '../models/MarketingTask.js';
import {
  MarketingTeamMember, MarketingMemberRole, MarketingMemberMetric, MarketingMetric, MarketingGroup, MarketingEodEntry,
  MarketingDashboardRemark,
} from '../models/MarketingEod.js';
import Attendance from '../models/Attendance.js';
import LeaveRequest from '../models/LeaveRequest.js';
import Holiday from '../models/Holiday.js';
import User from '../models/User.js';
import Project from '../models/Project.js';
import { notify, NOTIFICATION_TYPES } from '../utils/notify.js';
import {
  toDateStr, isManagerOrAdmin, canViewTeam, isOwnMember, findOwnMember, getCalendarSetting, logAudit,
} from './marketingEodController.js';
import { rebuildDay, sumLogs } from '../services/marketingRollup.js';
import MarketingShoot from '../models/MarketingShoot.js';
import Campaign from '../models/Campaign.js';
import StrategicInitiative from '../models/StrategicInitiative.js';
import DevProject from '../models/DevProject.js';
import CoordRequest from '../models/CoordRequest.js';
import ContentItem from '../models/ContentItem.js';
import MarketingWorkMode from '../models/MarketingWorkMode.js';
import { marketingTimebox } from '../services/marketingTimebox.js';
import { syncShootFromLogs } from '../services/marketingShootSync.js';
import { leadScopeFor, loadLeadWindow, bookingContext } from '../services/marketingLeadReportData.js';
import { cleanActivityInput, cleanTaskInput, isDay } from '../utils/marketingActivityInput.js';
import { leadConversionByUser } from '../utils/marketingTeamLeads.js';
import * as S from '../utils/marketingTeamStats.js';

// The Marketing Team Dashboard and the Log Activity record behind it (the document's "log once, store once, reflect everywhere").
// Routes: routes/marketingTeamRoutes.js, mounted at /api/marketing/team.
//   a member sees and logs their own work; a manager / admin / management sees all (leaders: read only, enforced by the CEO guard).

const IST = 5.5 * 60 * 60 * 1000;
const istStart = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - IST);
const istEnd = (day) => istStart(S.addDays(day, 1));
const idOf = (v) => (v == null ? '' : String(v._id ?? v));
const fail = (res, status, message, extra = {}) => res.status(status).json({ message, ...extra });
const isManager = (u) => isManagerOrAdmin(u);

const weekOf = (today) => {
  const dow = new Date(Date.parse(`${today}T00:00:00Z`)).getUTCDay(); // 0 = Sunday
  const monday = S.addDays(today, -((dow + 6) % 7));
  return { from: monday, to: S.addDays(monday, 6) };
};

/** ?from=&to= (defaults to this week, Monday to Sunday) → { from, to, today } or { error }. */
const parseRange = (req) => {
  const today = toDateStr();
  const dflt = weekOf(today);
  const from = req.query.from ?? dflt.from;
  const to = req.query.to ?? dflt.to;
  if (!isDay(from) || !isDay(to)) return { error: 'The dates must be YYYY-MM-DD.' };
  if (to < from) return { error: 'The end date is before the start date.' };
  if (S.daysBetween(from, to) > 366) return { error: 'Choose a range of a year or less.' };
  return { from, to, today };
};

const parseBrand = (req) => {
  const b = String(req.query.brand ?? 'all').toLowerCase();
  return ['all', 'main', 'kerala'].includes(b) ? b : null;
};
const brandQuery = (brand) => (brand === 'all' ? {} : { brand });

const memberInRange = (m, from, to) => {
  const a = m.activeFrom ? S.istDay(m.activeFrom) : null;
  const z = m.activeTo ? S.istDay(m.activeTo) : null;
  if (m.isActive === false && (!z || z < from)) return false;
  return (!a || a <= to) && (!z || z >= from);
};

/** Who the caller may look at: everyone on the team (managers, management), or only themselves. */
const loadScope = async (req, { from, to }) => {
  const viewer = canViewTeam(req.user);
  const own = await findOwnMember(req.user);
  const asked = req.query.memberId ? String(req.query.memberId) : '';
  if (!viewer) {
    if (!own) return { error: { status: 403, message: 'You are not on the Marketing team.' } };
    if (asked && asked !== idOf(own)) return { error: { status: 403, message: 'You can only see your own work.' } };
    return { viewer, own: own.toObject(), members: [own.toObject()] };
  }
  let members = (await MarketingTeamMember.find().sort({ sortOrder: 1, name: 1 }).lean()).filter((m) => memberInRange(m, from, to));
  if (asked) members = members.filter((m) => idOf(m) === asked);
  return { viewer, own: own ? own.toObject() : null, members };
};

/** The role name each member held in the month (latest role history entry up to that month). */
const roleNames = async (members, monthStr) => {
  const rows = await MarketingMemberRole.find({ memberId: { $in: members.map((m) => m._id) }, fromMonth: { $lte: monthStr } }).sort({ fromMonth: -1 }).populate('roleId').lean();
  const out = new Map();
  for (const r of rows) if (!out.has(idOf(r.memberId))) out.set(idOf(r.memberId), r.roleId?.name ?? '');
  return out;
};

const withRoles = async (members, monthStr) => {
  const names = await roleNames(members, monthStr);
  return members.map((m) => ({ ...m, roleName: names.get(idOf(m)) ?? '' }));
};

const groupNamer = async () => {
  const groups = await MarketingGroup.find().lean();
  const by = new Map(groups.map((g) => [idOf(g), g.name]));
  // Coordinations requests count under the "Coordination" group (the seeded one), when the team has it
  const coordination = groups.find((g) => /^coordinations?$/i.test(String(g.name ?? '').trim()));
  return { groups, name: (id) => (id ? by.get(String(id)) ?? '' : ''), coordinationGroupId: coordination ? idOf(coordination) : null };
};

/** Working-day context (weekly off, holidays, approved leave) and the member → employee mapping for the range. */
const loadContext = async (members, from, to) => {
  const setting = await getCalendarSetting();
  const holidays = new Set((await Holiday.find({ date: { $gte: istStart(from), $lt: istEnd(to) } }).lean()).map((h) => new Date(h.date).toISOString().slice(0, 10)));
  const userIds = members.map((m) => m.userId).filter(Boolean);
  const users = userIds.length ? await User.find({ _id: { $in: userIds } }).select('employeeId').lean() : [];
  const employeeByUser = new Map(users.map((u) => [idOf(u), idOf(u.employeeId)]));
  const employeeByMember = new Map(members.map((m) => [idOf(m), m.userId ? employeeByUser.get(idOf(m.userId)) ?? '' : '']));
  const employeeIds = [...new Set([...employeeByMember.values()].filter(Boolean))];
  const leaves = new Map();
  if (employeeIds.length) {
    const reqs = await LeaveRequest.find({ employeeId: { $in: employeeIds }, status: 'approved', fromDate: { $lt: istEnd(to) }, toDate: { $gte: istStart(from) } }).lean();
    for (const m of members) {
      const emp = employeeByMember.get(idOf(m));
      if (!emp) continue;
      const set = new Set();
      for (const r of reqs.filter((x) => idOf(x.employeeId) === emp)) {
        if (r.halfDay && r.halfDay !== 'none') continue; // half a day off is still a day to log
        for (const d of S.eachDay(S.istDay(r.fromDate), S.istDay(r.toDate))) if (d >= from && d <= to) set.add(d);
      }
      leaves.set(idOf(m), set);
    }
  }
  return { ctx: { weeklyOff: setting.weeklyOff ?? 0, holidays, leaves }, employeeOf: (m) => employeeByMember.get(idOf(m)) ?? '', employeeIds };
};

const loadActivities = (members, from, to, brand) =>
  MarketingActivity.find({ memberId: { $in: members.map((m) => m._id) }, entryDate: { $gte: from, $lte: to }, ...brandQuery(brand) }).sort({ loggedAt: -1 }).lean();

/** The rule for "tasks that matter for the range": open now, completed in it, or due in it. */
const taskRangeOr = (from, to) => [{ status: { $ne: 'completed' } }, { completedAt: { $gte: istStart(from), $lt: istEnd(to) } }, { dueDate: { $gte: from, $lte: to } }];
const requestRangeOr = (from, to) => [{ status: { $nin: ['completed', 'cancelled'] } }, { closedAt: { $gte: istStart(from), $lt: istEnd(to) } }, { dueDate: { $gte: from, $lte: to } }];

/** The Coordinations requests given to these members that matter for the range, read as their tasks (utils/marketingTeamStats.js requestAsTask). */
const loadRequestTasks = async (filter, from, to, brand) => {
  const { coordinationGroupId } = await groupNamer();
  const rows = await CoordRequest.find({ ...filter, ...brandQuery(brand), status: { $ne: 'cancelled' }, ...(from && to ? { $or: requestRangeOr(from, to) } : {}) }).limit(2000).lean();
  return rows.map((r) => S.requestAsTask(r, { groupId: coordinationGroupId })).filter(Boolean);
};

/** Tasks that matter for the range — the team's own tasks AND the Coordinations requests given to its members (one task record, read by both screens). */
const loadTasks = async (members, from, to, brand) => {
  const ids = members.map((m) => m._id);
  const [tasks, requests] = await Promise.all([
    MarketingTask.find({ assigneeId: { $in: ids }, ...brandQuery(brand), $or: taskRangeOr(from, to) }).lean(),
    loadRequestTasks({ assigneeId: { $in: ids } }, from, to, brand),
  ]);
  return [...tasks, ...requests];
};

/** "memberId|day" for every day a member logged. All brands: the EOD day entries (they include days entered the old way); one brand: that brand's logs. */
const loadLogged = async (members, from, to, brand, activities) => {
  if (brand === 'all') {
    const entries = await MarketingEodEntry.find({ memberId: { $in: members.map((m) => m._id) }, entryDate: { $gte: from, $lte: to } }).select('memberId entryDate').lean();
    return new Set(entries.map((e) => `${idOf(e.memberId)}|${e.entryDate}`));
  }
  return new Set(activities.map((a) => `${idOf(a.memberId)}|${a.entryDate}`));
};

const attendanceByEmployee = async (employeeIds, day) => {
  if (!employeeIds.length) return new Map();
  const rows = await Attendance.find({ employeeId: { $in: employeeIds }, date: { $gte: istStart(day), $lt: istEnd(day) } }).lean();
  return new Map(rows.map((r) => [idOf(r.employeeId), r]));
};

/** One day of Timebox for memberStates — only when Timebox answered: { linked: Set<memberId>, days: Map<memberId, Timebox day> }. */
const timeboxDay = (tb, day) => {
  if (!tb?.status?.ok) return null;
  const days = new Map();
  for (const mid of tb.links.keys()) {
    const r = tb.days.get(`${mid}|${day}`);
    if (r) days.set(mid, r);
  }
  return { linked: new Set(tb.links.keys()), days };
};

/** What the screens say about Timebox: connected or not, how many members it covers, who is not linked, and any problem in words. */
const timeboxView = (tb) => ({ mode: tb.status.mode, ok: tb.status.ok, problem: tb.status.problem, linked: tb.status.linked, unlinked: tb.status.unlinked });

/** The work mode each member set for the day: Map<memberId, mode>. */
const modesFor = async (members, day) => {
  if (!members.length) return new Map();
  const rows = await MarketingWorkMode.find({ memberId: { $in: members.map((m) => m._id) }, day }).select('memberId mode').lean();
  return new Map(rows.map((r) => [idOf(r.memberId), r.mode]));
};

const feedItem = (a, memberName, groupName) => ({
  id: idOf(a),
  at: a.loggedAt,
  day: a.entryDate,
  memberId: idOf(a.memberId),
  member: memberName.get(idOf(a.memberId)) ?? '',
  workedOn: a.workedOn,
  projectLabel: a.projectLabel,
  projectKey: S.projectKeyOf(a),
  kind: a.kind,
  status: a.status,
  minutes: a.timeSpentMinutes,
  brand: a.brand,
  group: groupName(idOf(a.groupId)),
  groupId: a.groupId ? idOf(a.groupId) : null,
  taskId: a.taskId ? idOf(a.taskId) : null,
  contentId: a.contentId ? idOf(a.contentId) : null,
  legacy: !!a.legacy,
});

// ── the Log Activity form ────────────────────────────────────────────────────

/** Which member a log is for, and may the caller write to them? → { member } | { error } */
const memberForWrite = async (req, requestedId) => {
  const own = await findOwnMember(req.user);
  if (!requestedId || (own && String(requestedId) === idOf(own))) {
    if (!own) return { error: { status: 403, message: 'You are not on the Marketing team, so there is nothing to log for.' } };
    return { member: own, self: true };
  }
  if (!isManager(req.user)) return { error: { status: 403, message: 'Only the Marketing Manager or Admin can log for someone else.' } };
  if (!mongoose.isValidObjectId(requestedId)) return { error: { status: 400, message: 'Unknown team member.' } };
  const member = await MarketingTeamMember.findById(requestedId);
  if (!member) return { error: { status: 404, message: 'Team member not found.' } };
  return { member, self: false };
};

const monthLocked = async (memberId, day) => {
  const r = await MarketingDashboardRemark.findOne({ memberId, month: day.slice(0, 7) }).select('monthStatus').lean();
  return r?.monthStatus === 'closed';
};

// @route GET /api/marketing/team/log-setup?memberId=&date=
// What the Log Activity form needs: the member's activities for the month (grouped), their open tasks, projects to pick, and the
// day's logs so far.
export const getLogSetup = async (req, res) => {
  try {
    const date = req.query.date ?? toDateStr();
    if (!isDay(date)) return fail(res, 400, 'The date must be YYYY-MM-DD.');
    const who = await memberForWrite(req, req.query.memberId ? String(req.query.memberId) : '');
    if (who.error) return fail(res, who.error.status, who.error.message);
    const { member, self } = who;
    const month = date.slice(0, 7);
    const manager = isManager(req.user);

    const set = await MarketingMemberMetric.find({ memberId: member._id, fromMonth: { $lte: month }, $or: [{ toMonth: null }, { toMonth: { $gte: month } }] }).lean();
    const allowed = new Set(set.map((s) => idOf(s.metricId)));
    const metrics = await MarketingMetric.find({ isActive: true }).sort({ sortOrder: 1, code: 1 }).lean();
    const { groups } = await groupNamer();
    const mine = metrics.filter((m) => manager || allowed.has(idOf(m)));
    const grouped = groups
      .map((g) => ({ id: idOf(g), name: g.name, sortOrder: g.sortOrder, metrics: mine.filter((m) => idOf(m.groupId) === idOf(g)).map((m) => ({ id: idOf(m), code: m.code, name: m.name, unitType: m.unitType, maxPerDay: m.maxPerDay })) }))
      .filter((g) => g.metrics.length)
      .sort((a, b) => a.sortOrder - b.sortOrder);

    const tasks = await MarketingTask.find({ assigneeId: member._id, status: { $ne: 'completed' } }).sort({ dueDate: 1 }).limit(100).select('title dueDate status progress priority groupId').lean();
    const projects = await Project.find({ status: { $nin: ['cancelled', 'completed'] } }).sort({ name: 1 }).limit(100).select('name').lean();
    const logs = await MarketingActivity.find({ memberId: member._id, entryDate: date }).sort({ loggedAt: 1 }).lean();
    // shoots a log can be tied to: not finished or cancelled, within a month either side of the day (the Creative Portfolio's planner)
    const shoots = await MarketingShoot.find({ status: { $nin: ['completed', 'cancelled'] }, shootDate: { $gte: S.addDays(date, -45), $lte: S.addDays(date, 45) } }).sort({ shootDate: 1 }).limit(60).select('title brand shootDate status').lean();
    // what a log or a task can be tied to: the open campaigns, initiatives and development projects (Campaigns / Strategies modules)
    const [campaigns, initiatives, devProjects] = await Promise.all([
      Campaign.find({ status: { $in: ['planned', 'active', 'paused'] } }).sort({ title: 1 }).limit(100).select('title status').lean(),
      StrategicInitiative.find({ status: { $in: ['planned', 'active', 'on_hold'] } }).sort({ title: 1 }).limit(100).select('title status').lean(),
      DevProject.find({ status: { $in: ['planned', 'in_progress', 'on_hold'] } }).sort({ name: 1 }).limit(100).select('name status').lean(),
    ]);
    // the Socials posts a log can publish: not published or cancelled, planned within a month either side of the day — plus any post
    // a log of the day is already tied to (so editing that log still shows it)
    const linked = logs.map((l) => l.contentId).filter(Boolean);
    const posts = await ContentItem.find({ $or: [{ status: { $nin: ['published', 'cancelled'] }, scheduledDate: { $gte: istStart(S.addDays(date, -31)), $lt: istEnd(S.addDays(date, 31)) } }, ...(linked.length ? [{ _id: { $in: linked } }] : [])] })
      .sort({ scheduledDate: 1 })
      .limit(80)
      .select('title platform contentType brand status scheduledDate')
      .lean();
    const mode = await MarketingWorkMode.findOne({ memberId: member._id, day: date }).select('mode').lean();
    const setting = await getCalendarSetting();
    const today = toDateStr();
    const diff = S.daysBetween(date, today);
    const locked = await monthLocked(member._id, date);
    const canEdit = !locked && date <= today && (manager || diff <= (setting.editWindowDays ?? 2));

    res.json({
      member: { id: idOf(member), name: member.name, shortName: member.shortName },
      self,
      canLogForOthers: manager,
      members: manager ? (await MarketingTeamMember.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).select('name shortName').lean()).map((m) => ({ id: idOf(m), name: m.name })) : [],
      date,
      groups: grouped,
      // every activity group (the category a log or a task counts under), whether or not the member counts anything in it
      categories: groups.filter((g) => g.isActive !== false).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)).map((g) => ({ id: idOf(g), name: g.name })),
      tasks: tasks.map((t) => ({ id: idOf(t), title: t.title, dueDate: t.dueDate, status: t.status, progress: t.progress, priority: t.priority, groupId: t.groupId ? idOf(t.groupId) : null })),
      projects: projects.map((p) => ({ id: idOf(p), name: p.name })),
      shoots: shoots.map((x) => ({ id: idOf(x), title: x.title, brand: x.brand, shootDate: x.shootDate, status: x.status })),
      campaigns: campaigns.map((x) => ({ id: idOf(x), title: x.title, status: x.status })),
      initiatives: initiatives.map((x) => ({ id: idOf(x), title: x.title, status: x.status })),
      devProjects: devProjects.map((x) => ({ id: idOf(x), name: x.name, status: x.status })),
      posts: posts.map((x) => ({ id: idOf(x), title: x.title, platform: x.platform, contentType: x.contentType, brand: x.brand, status: x.status, day: x.scheduledDate ? S.istDay(x.scheduledDate) : null })),
      workMode: mode?.mode ?? null,
      logs: logs.map((l) => ({ ...l, id: idOf(l), memberId: idOf(l.memberId) })),
      totals: (({ hours, minutes, values }) => ({ hours, minutes, values }))(sumLogs(logs)),
      canEdit,
      notice: locked ? 'This month is closed. A manager has to reopen it before anything changes.' : date > today ? 'You cannot log work for a future date.' : !canEdit ? `You can change a log for ${setting.editWindowDays ?? 2} days; ask the Marketing Manager.` : '',
    });
  } catch (error) {
    fail(res, 500, error.message);
  }
};

/** The group an activity counts under (utils/marketingTeamStats.js pickGroup): the one the form chose, else its biggest count's, else its task's. */
const groupFor = async (values, chosen, taskId) => {
  let countGroup = null;
  if (values.length) {
    const best = [...values].sort((a, b) => b.value - a.value)[0];
    const metric = await MarketingMetric.findById(best.metricId).select('groupId').lean();
    if (metric?.groupId) countGroup = idOf(metric.groupId);
  }
  const task = !chosen && !countGroup && taskId ? await MarketingTask.findById(taskId).select('groupId').lean() : null;
  return S.pickGroup({ chosen, countGroup, taskGroup: task?.groupId ? idOf(task.groupId) : null });
};

// ── a log that published a Socials post ───────────────────────────────────────

/** The moment a back-dated log says the post went out: now for today's log, else midday (IST) of the log's day. */
const publishMoment = (day, today) => (day === today ? new Date() : new Date(istStart(day).getTime() + 12 * 3600 * 1000));

/** Put a post back the way it was before a log published it — only while it is still exactly as that log left it. */
const restoreContent = async (contentId, before) => {
  if (!contentId || !before) return;
  await ContentItem.updateOne({ _id: contentId, status: 'published', publishedDate: before.publishedAt ?? null }, { $set: { status: before.status || 'scheduled', publishedDate: before.publishedDate ?? null } });
};

/**
 * Keep the linked Socials post in step with the log (the matrix's "reel, story or post published"): a COMPLETED log tied to a post marks
 * the post published, on the log's day — the Socials tracker, the Team Dashboard and the Weekly Report then all read that one entry. A
 * post already published stays as it is. A log moved off the post, no longer completed, or deleted puts the post back (if nothing else
 * changed it since). `previous` = the log's { contentId, contentBefore } before this save.
 */
const syncContent = async ({ activity, previous = null, today }) => {
  const now = activity.contentId ? idOf(activity.contentId) : '';
  const was = previous?.contentId ? idOf(previous.contentId) : '';
  const done = activity.status === 'completed';
  let before = was && was === now ? previous?.contentBefore ?? null : null;
  if (was && previous?.contentBefore && (was !== now || !done)) {
    await restoreContent(was, previous.contentBefore);
    before = null;
  }
  if (now && done && !before) {
    const when = publishMoment(activity.entryDate, today);
    const old = await ContentItem.findOneAndUpdate({ _id: now, status: { $nin: ['published', 'cancelled'] } }, { $set: { status: 'published', publishedDate: when } }, { new: false }).select('status publishedDate').lean();
    if (old) before = { status: old.status, publishedDate: old.publishedDate ?? null, publishedAt: when };
  }
  const keep = before ? { status: before.status, publishedDate: before.publishedDate ?? null, publishedAt: before.publishedAt ?? null } : null;
  await MarketingActivity.updateOne({ _id: activity._id }, { $set: { contentBefore: keep } });
  return keep;
};

/** Keep a linked task in step with the log: completing the log completes the task; progress moves it; deleting that log reopens it. */
const syncTask = async ({ taskId, activity, input, previous = null }) => {
  if (!taskId) return;
  const task = await MarketingTask.findById(taskId);
  if (!task) return;
  const id = idOf(activity);
  if (input.status === 'completed') {
    task.status = 'completed';
    task.progress = 100;
    task.completedAt = new Date();
    task.completedByActivityId = activity._id;
  } else {
    if (idOf(task.completedByActivityId) === id) {
      task.completedAt = null;
      task.completedByActivityId = null;
      if (task.status === 'completed') task.status = 'in_progress';
      if (task.progress === 100) task.progress = 90;
    }
    if (input.taskProgress != null) task.progress = input.taskProgress;
    if (input.status === 'blocked' || input.status === 'pending') task.status = input.status;
    else if (task.status !== 'completed') task.status = task.progress > 0 || input.status === 'in_progress' ? 'in_progress' : task.status;
  }
  await task.save();
};

const reopenIfCompletedBy = async (activity) => {
  if (!activity.taskId) return;
  const task = await MarketingTask.findById(activity.taskId);
  if (!task || idOf(task.completedByActivityId) !== idOf(activity)) return;
  task.completedAt = null;
  task.completedByActivityId = null;
  task.status = 'in_progress';
  task.progress = Math.min(task.progress, 90);
  await task.save();
};

const writeActivity = async (req, res, existing = null) => {
  const today = toDateStr();
  const input = cleanActivityInput(req.body, { today });
  if (!input.ok) return fail(res, 400, input.message, { field: input.field });
  const v = input.value;

  const who = await memberForWrite(req, existing ? idOf(existing.memberId) : req.body.memberId ? String(req.body.memberId) : '');
  if (who.error) return fail(res, who.error.status, who.error.message);
  const { member, self } = who;
  if (existing && !self && !isManager(req.user)) return fail(res, 403, 'You can only change your own logs.');
  const manager = isManager(req.user);

  // the day must be open and inside the edit window (managers may go further back, with a reason)
  const setting = await getCalendarSetting();
  const window = setting.editWindowDays ?? 2;
  const lateDays = S.daysBetween(v.entryDate, today);
  const oldDay = existing?.entryDate;
  for (const day of [v.entryDate, ...(oldDay && oldDay !== v.entryDate ? [oldDay] : [])]) {
    if (await monthLocked(member._id, day)) return fail(res, 403, manager ? 'This month is closed. Reopen it in Month Close before changing logs.' : 'This month is closed. Only the Manager can reopen it.');
  }
  if (lateDays > window && !manager) return fail(res, 403, `You can log or change work for ${window} days back. Ask the Marketing Manager for older days.`);
  const needsReason = manager && (!self || lateDays > window);
  const reason = String(req.body.overrideReason ?? '').trim();
  if (needsReason && !reason) return fail(res, 400, "A reason is required when logging for someone else or for an older day.", { reasonRequired: true });

  // counts must be in the member's activity set for the month (managers may add any); and whole numbers unless money
  const month = v.entryDate.slice(0, 7);
  const set = await MarketingMemberMetric.find({ memberId: member._id, fromMonth: { $lte: month }, $or: [{ toMonth: null }, { toMonth: { $gte: month } }] }).lean();
  const allowed = new Set(set.map((s) => idOf(s.metricId)));
  const before = new Set((existing?.values ?? []).map((x) => idOf(x.metricId)));
  const metrics = await MarketingMetric.find({ _id: { $in: v.values.map((x) => x.metricId) } }).lean();
  const byId = new Map(metrics.map((m) => [idOf(m), m]));
  const warnings = [];
  for (const val of v.values) {
    const m = byId.get(val.metricId);
    if (!m) return fail(res, 400, 'A count names an unknown activity.', { field: 'values' });
    if (m.unitType !== 'currency' && !Number.isInteger(val.value)) return fail(res, 400, `${m.name} must be a whole number.`, { field: 'values' });
    if (!manager && !allowed.has(val.metricId) && !before.has(val.metricId)) return fail(res, 403, `${m.name} is not one of your activities for this month.`, { field: 'values' });
    if (!m.isActive && !before.has(val.metricId)) return fail(res, 400, `${m.name} is no longer active.`, { field: 'values' });
    if (m.maxPerDay != null && val.value > m.maxPerDay) warnings.push(`${m.name}: ${val.value} is above the usual daily maximum of ${m.maxPerDay}.`);
  }

  // a day has 24 hours
  const sameDay = await MarketingActivity.find({ memberId: member._id, entryDate: v.entryDate, ...(existing ? { _id: { $ne: existing._id } } : {}) }).select('timeSpentMinutes').lean();
  const dayMinutes = sameDay.reduce((s, a) => s + (a.timeSpentMinutes || 0), 0) + v.timeSpentMinutes;
  if (dayMinutes > 1440) return fail(res, 400, 'That is more than 24 hours logged for one day.', { field: 'timeSpentMinutes' });

  if (v.taskId) {
    const task = await MarketingTask.findById(v.taskId).select('assigneeId').lean();
    if (!task) return fail(res, 400, 'That task no longer exists.', { field: 'taskId' });
    if (idOf(task.assigneeId) !== idOf(member) && !manager) return fail(res, 403, 'That task is not yours.', { field: 'taskId' });
  }

  if (v.shootId) {
    const shoot = await MarketingShoot.findById(v.shootId).select('_id').lean();
    if (!shoot) return fail(res, 400, 'That shoot no longer exists.', { field: 'shootId' });
  }
  if (v.campaignId && !(await Campaign.exists({ _id: v.campaignId }))) return fail(res, 400, 'That campaign no longer exists.', { field: 'campaignId' });
  if (v.initiativeId && !(await StrategicInitiative.exists({ _id: v.initiativeId }))) return fail(res, 400, 'That initiative no longer exists.', { field: 'initiativeId' });
  if (v.devProjectId && !(await DevProject.exists({ _id: v.devProjectId }))) return fail(res, 400, 'That development project no longer exists.', { field: 'devProjectId' });
  if (v.projectId && !(await Project.exists({ _id: v.projectId }))) return fail(res, 400, 'That project no longer exists.', { field: 'projectId' });
  if (v.groupId && !(await MarketingGroup.exists({ _id: v.groupId }))) return fail(res, 400, 'That category no longer exists.', { field: 'groupId' });
  if (v.contentId) {
    const post = await ContentItem.findById(v.contentId).select('status').lean();
    if (!post) return fail(res, 400, 'That post no longer exists.', { field: 'contentId' });
    if (post.status === 'cancelled' && !(existing && idOf(existing.contentId) === v.contentId)) return fail(res, 400, 'That post was cancelled in Socials, so it cannot be published from a log.', { field: 'contentId' });
  }

  const groupId = await groupFor(v.values, v.groupId, v.taskId);
  const roleName = (await roleNames([member], month)).get(idOf(member)) ?? '';
  const { taskProgress, ...fields } = v;
  const payload = { ...fields, memberId: member._id, roleName, groupId, lastEditedBy: req.user._id, lastEditedAt: new Date() };
  const previousContent = existing ? { contentId: existing.contentId, contentBefore: existing.contentBefore ? { ...existing.contentBefore.toObject?.() ?? existing.contentBefore } : null } : null;

  let activity;
  if (existing) {
    Object.assign(existing, payload);
    activity = await existing.save();
  } else {
    activity = await MarketingActivity.create({ ...payload, loggedAt: new Date(), createdBy: req.user._id });
  }
  await syncTask({ taskId: v.taskId, activity, input: { ...v, taskProgress }, previous: existing });
  // the log used to be linked to another task that it had completed: that one reopens
  if (existing && existing.taskId && v.taskId && idOf(existing.taskId) !== v.taskId) await reopenIfCompletedBy({ _id: activity._id, taskId: existing.taskId });

  // the shoot's milestones follow the work logged against it (a log moved off a shoot is taken out of that shoot's milestones too)
  await syncShootFromLogs(v.shootId);
  if (existing && existing.shootId && idOf(existing.shootId) !== v.shootId) await syncShootFromLogs(idOf(existing.shootId));

  // the Socials post the work published follows the log (published once, put back if the log stops saying so)
  const contentBefore = await syncContent({ activity, previous: previousContent, today });

  await rebuildDay(member._id, v.entryDate, { editedBy: req.user._id });
  if (oldDay && oldDay !== v.entryDate) await rebuildDay(member._id, oldDay, { editedBy: req.user._id });

  if (existing || !self || lateDays > window) {
    await logAudit({ table: 'mkt_activity', recordId: activity._id, oldValue: existing ? { day: oldDay } : null, newValue: { day: v.entryDate, minutes: v.timeSpentMinutes }, user: req.user, reason: reason || (self ? 'Member updated a log' : 'Manager logged on behalf of member') });
  }
  res.status(existing ? 200 : 201).json({ activity: { ...activity.toObject(), contentBefore, id: idOf(activity), memberId: idOf(activity.memberId) }, published: !!contentBefore, warnings });
};

// @route POST /api/marketing/team/activities
export const createActivity = async (req, res) => {
  try {
    await writeActivity(req, res, null);
  } catch (error) {
    fail(res, 500, error.message);
  }
};

// @route PUT /api/marketing/team/activities/:id
export const updateActivity = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 404, 'Log not found');
    const existing = await MarketingActivity.findById(req.params.id);
    if (!existing) return fail(res, 404, 'Log not found');
    if (existing.legacy) return fail(res, 409, 'This is the earlier whole-day entry kept from before Log Activity; add logs for the day instead.');
    await writeActivity(req, res, existing);
  } catch (error) {
    fail(res, 500, error.message);
  }
};

// @route DELETE /api/marketing/team/activities/:id
export const deleteActivity = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 404, 'Log not found');
    const activity = await MarketingActivity.findById(req.params.id);
    if (!activity) return fail(res, 404, 'Log not found');
    const member = await MarketingTeamMember.findById(activity.memberId);
    const self = member && isOwnMember(req.user, member);
    const manager = isManager(req.user);
    if (!self && !manager) return fail(res, 403, 'You can only delete your own logs.');
    if (await monthLocked(activity.memberId, activity.entryDate)) return fail(res, 403, 'This month is closed. Reopen it in Month Close first.');
    const setting = await getCalendarSetting();
    const late = S.daysBetween(activity.entryDate, toDateStr()) > (setting.editWindowDays ?? 2);
    if (late && !manager) return fail(res, 403, 'The edit window has passed. Ask the Marketing Manager.');
    const reason = String(req.body?.overrideReason ?? req.query.reason ?? '').trim();
    if (manager && (!self || late) && !reason) return fail(res, 400, 'A reason is required to delete someone else\'s log or an older one.', { reasonRequired: true });
    await reopenIfCompletedBy(activity);
    // a post this log published goes back to how it was (unless it was changed since)
    if (activity.contentId && activity.contentBefore) await restoreContent(activity.contentId, activity.contentBefore);
    await activity.deleteOne();
    await syncShootFromLogs(activity.shootId); // the shoot's milestones follow its remaining logs
    await rebuildDay(activity.memberId, activity.entryDate, { editedBy: req.user._id });
    await logAudit({ table: 'mkt_activity', recordId: activity._id, oldValue: { day: activity.entryDate, workedOn: activity.workedOn, minutes: activity.timeSpentMinutes }, newValue: null, user: req.user, reason: reason || 'Member deleted a log' });
    res.json({ message: 'Log deleted' });
  } catch (error) {
    fail(res, 500, error.message);
  }
};

// ── Team Activity ────────────────────────────────────────────────────────────

// @route GET /api/marketing/team/activity?from&to&brand&memberId&group&kind&project&page&limit
// The feed of logs, newest first, with Today's Summary and the By Member / By Project / By Category views (all counted from the same
// logs). Every cut is made here, on the server: kind, category (`group` — a group id, or 'others' for none), `project` (a key from
// utils/marketingTeamStats.js projectKeyOf, or a CRM `projectId`) and the member. The summary and the three views are of the period
// and brand (not narrowed by the kind / category / project picked), so they always add up to the whole; the feed is the narrowed list.
export const getTeamActivity = async (req, res) => {
  try {
    const range = parseRange(req);
    if (range.error) return fail(res, 400, range.error);
    const brand = parseBrand(req);
    if (!brand) return fail(res, 400, 'Brand must be all, main or kerala.');
    const kind = req.query.kind ? String(req.query.kind) : '';
    if (kind && !['task', 'meeting', 'shoot', 'post', 'campaign', 'strategy', 'other'].includes(kind)) return fail(res, 400, 'Unknown kind of activity.');
    const scope = await loadScope(req, range);
    if (scope.error) return fail(res, scope.error.status, scope.error.message);
    const { name: groupName } = await groupNamer();
    const names = new Map(scope.members.map((m) => [idOf(m), m.name]));
    const all = await loadActivities(scope.members, range.from, range.to, brand);
    let acts = all;
    if (req.query.group) acts = acts.filter((a) => (String(req.query.group) === 'others' ? !groupName(idOf(a.groupId)) : idOf(a.groupId) === String(req.query.group)));
    if (kind) acts = acts.filter((a) => a.kind === kind);
    if (req.query.projectId) acts = acts.filter((a) => idOf(a.projectId) === String(req.query.projectId));
    if (req.query.project) acts = acts.filter((a) => S.projectKeyOf(a) === String(req.query.project).trim().toLowerCase());
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const day = range.today >= range.from && range.today <= range.to ? range.today : range.to;
    const dayActs = all.filter((a) => a.entryDate === day);
    const projectIds = [...new Set(all.map((a) => idOf(a.projectId)).filter((id) => mongoose.isValidObjectId(id)))];
    const projectNames = new Map(projectIds.length ? (await Project.find({ _id: { $in: projectIds } }).select('name').lean()).map((p) => [idOf(p), p.name]) : []);
    res.json({
      from: range.from,
      to: range.to,
      views: S.activityBreakdown({ activities: all, memberName: (id) => names.get(id) ?? '', groupName, projectName: (id) => projectNames.get(id) ?? '' }),
      summary: {
        day,
        logged: dayActs.length,
        completed: dayActs.filter((a) => a.status === 'completed').length,
        inProgress: dayActs.filter((a) => a.status === 'in_progress').length,
        meetings: dayActs.filter((a) => a.kind === 'meeting').length,
        minutes: dayActs.reduce((s, a) => s + (a.timeSpentMinutes || 0), 0),
      },
      total: acts.length,
      page,
      pageSize: limit,
      items: acts.slice((page - 1) * limit, page * limit).map((a) => feedItem(a, names, groupName)),
    });
  } catch (error) {
    fail(res, 500, error.message);
  }
};

// ── Overview ─────────────────────────────────────────────────────────────────

// @route GET /api/marketing/team/overview?from&to&brand&memberId
export const getTeamOverview = async (req, res) => {
  try {
    const range = parseRange(req);
    if (range.error) return fail(res, 400, range.error);
    const brand = parseBrand(req);
    if (!brand) return fail(res, 400, 'Brand must be all, main or kerala.');
    const scope = await loadScope(req, range);
    if (scope.error) return fail(res, scope.error.status, scope.error.message);
    const { from, to, today } = range;
    const members = await withRoles(scope.members, (to < today ? to : today).slice(0, 7));
    const { name: groupName } = await groupNamer();
    const { ctx, employeeOf, employeeIds } = await loadContext(members, from, to);
    const [acts, tasks] = await Promise.all([loadActivities(members, from, to, brand), loadTasks(members, from, to, brand)]);
    const logged = await loadLogged(members, from, to, brand, acts);
    const days = S.eachDay(from, to);

    const items = S.buildItems({ tasks, activities: acts, from, to });
    const k = S.kpiCounts(items);
    const prev = S.previousRange({ from, to });
    const prevActs = await loadActivities(members, prev.from, prev.to, brand);
    const prevTasks = await loadTasks(members, prev.from, prev.to, brand);
    const prevCompleted = S.kpiCounts(S.buildItems({ tasks: prevTasks, activities: prevActs, from: prev.from, to: prev.to })).completed;
    const rate = S.activityRate({ members, days, logged, today, ctx });

    const stateDay = to < today ? to : today;
    const att = await attendanceByEmployee(employeeIds, stateDay);
    const tb = await marketingTimebox(members, stateDay, stateDay, ['days']);
    const dayActs = stateDay === from || (stateDay >= from && stateDay <= to) ? acts.filter((a) => a.entryDate === stateDay) : [];
    const states = S.memberStates({ members, date: stateDay, activities: dayActs, attendanceByEmployee: att, leaves: ctx.leaves, employeeOf, modes: await modesFor(members, stateDay), timebox: timeboxDay(tb, stateDay) });
    const names = new Map(members.map((m) => [idOf(m), m.name]));
    const nextDeadlines = S.upcomingDeadlines(tasks, today, 6);
    const overdue = S.overdueCount(tasks, today);
    const joinedThisMonth = members.filter((m) => m.activeFrom && S.istDay(m.activeFrom).slice(0, 7) === to.slice(0, 7)).length;

    res.json({
      from, to, brand, today,
      kpis: {
        members: members.length,
        membersJoined: joinedThisMonth,
        tasksCompleted: k.completed,
        tasksCompletedChange: S.changePct(k.completed, prevCompleted),
        inProgress: k.inProgress,
        pendingBlocked: k.pendingBlocked,
        activityRate: rate.pct,
        onTimeDelivery: S.onTimeRate({ tasks, from, to }),
      },
      members: S.memberRows({ members, items, states }),
      todayFeed: dayActs.slice(0, 12).map((a) => feedItem(a, names, groupName)),
      todayDay: stateDay,
      workload: S.workloadByGroup(items, groupName),
      totalItems: items.length,
      progressByCategory: S.progressByGroup(items, groupName),
      trend: S.dailyTrend({ days, items, members, logged, today, ctx }),
      attendance: { day: stateDay, ...S.attendanceSummary(states), timebox: timeboxView(tb) },
      deadlines: nextDeadlines.map((t) => ({ id: idOf(t), title: t.title, project: t.projectLabel, dueDate: t.dueDate, assignee: names.get(idOf(t.assigneeId)) ?? '', priority: t.priority })),
      recentUpdates: acts.slice(0, 6).map((a) => feedItem(a, names, groupName)),
      insights: S.insights({ completed: k.completed, previousCompleted: prevCompleted, activityPct: rate.pct, pendingBlocked: k.pendingBlocked, overdue, nextDeadline: nextDeadlines[0] }),
    });
  } catch (error) {
    fail(res, 500, error.message);
  }
};

// ── Logs & Timesheet ─────────────────────────────────────────────────────────

// @route GET /api/marketing/team/timesheet?from&to&brand&memberId
export const getTimesheet = async (req, res) => {
  try {
    const range = parseRange(req);
    if (range.error) return fail(res, 400, range.error);
    const brand = parseBrand(req);
    if (!brand) return fail(res, 400, 'Brand must be all, main or kerala.');
    const scope = await loadScope(req, range);
    if (scope.error) return fail(res, scope.error.status, scope.error.message);
    const members = await withRoles(scope.members, range.to.slice(0, 7));
    const { name: groupName } = await groupNamer();
    const acts = await loadActivities(members, range.from, range.to, brand);
    const t = S.timesheet({ members, activities: acts, groupName });
    const days = S.eachDay(range.from, range.to);
    const metricInfo = await metricInfoFor(acts);
    // beside the hours logged: the hours Timebox counted from each person's punches (null = not linked to Timebox)
    const tb = await marketingTimebox(members, range.from, range.to, ['days']);
    const tbMinutes = new Map();
    if (tb.status.ok) {
      for (const mid of tb.links.keys()) tbMinutes.set(mid, 0);
      for (const [key, rec] of tb.days) {
        const mid = key.split('|')[0];
        if (rec.workedMinutes != null) tbMinutes.set(mid, (tbMinutes.get(mid) ?? 0) + rec.workedMinutes);
      }
    }
    const tbTotal = [...tbMinutes.values()].reduce((a, b) => a + b, 0);
    res.json({
      from: range.from,
      to: range.to,
      days,
      totalMinutes: t.totalMinutes,
      totalLabel: S.hoursLabel(t.totalMinutes),
      timeboxTotalMinutes: tb.status.ok && tbMinutes.size ? tbTotal : null,
      timeboxTotalLabel: tb.status.ok && tbMinutes.size ? S.hoursLabel(tbTotal) : '',
      timebox: timeboxView(tb),
      split: t.split,
      rows: t.rows.map((r) => ({
        ...r,
        label: S.hoursLabel(r.minutes),
        role: members.find((m) => idOf(m) === r.memberId)?.roleName ?? '',
        status: r.logs ? 'Submitted' : 'Not logged',
        timeboxMinutes: tbMinutes.has(r.memberId) ? tbMinutes.get(r.memberId) : null,
        timeboxLabel: tbMinutes.has(r.memberId) ? S.hoursLabel(tbMinutes.get(r.memberId)) : '',
      })),
      // the Work Summary and Activity Report tabs: the same logs, read two more ways
      workSummary: S.workSummary({ members, activities: acts }).map((r) => ({ ...r, role: members.find((m) => idOf(m) === r.memberId)?.roleName ?? '', hoursLabel: S.hoursLabel(r.minutes) })),
      activityReport: S.activityReport({ activities: acts, metricInfo: (id) => metricInfo.get(id), groupName }),
    });
  } catch (error) {
    fail(res, 500, error.message);
  }
};

/** Map<metricId, { name, groupId, unitType }> for the counts these logs carry. */
const metricInfoFor = async (acts) => {
  const ids = [...new Set(acts.flatMap((a) => (a.values ?? []).map((v) => idOf(v.metricId))))].filter((id) => mongoose.isValidObjectId(id));
  const rows = ids.length ? await MarketingMetric.find({ _id: { $in: ids } }).select('name groupId unitType').lean() : [];
  return new Map(rows.map((m) => [idOf(m), { name: m.name, groupId: idOf(m.groupId), unitType: m.unitType ?? 'count' }]));
};

// @route GET /api/marketing/team/logs?from&to&brand&memberId&page&limit
// Logs & Timesheet → Daily Logs: every log of the period, each with all it says (what was done, what is pending, the next priority, the
// time and the counts), newest day first. A member sees their own; a manager sees everyone's (the shared scope rule).
export const getLogs = async (req, res) => {
  try {
    const range = parseRange(req);
    if (range.error) return fail(res, 400, range.error);
    const brand = parseBrand(req);
    if (!brand) return fail(res, 400, 'Brand must be all, main or kerala.');
    const scope = await loadScope(req, range);
    if (scope.error) return fail(res, scope.error.status, scope.error.message);
    const { name: groupName } = await groupNamer();
    const names = new Map(scope.members.map((m) => [idOf(m), m.name]));
    const acts = (await loadActivities(scope.members, range.from, range.to, brand)).sort((a, b) => (a.entryDate === b.entryDate ? new Date(b.loggedAt) - new Date(a.loggedAt) : a.entryDate < b.entryDate ? 1 : -1));
    const metricInfo = await metricInfoFor(acts);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    res.json({
      from: range.from,
      to: range.to,
      total: acts.length,
      totalMinutes: acts.reduce((sum, a) => sum + (a.timeSpentMinutes || 0), 0),
      page,
      pageSize: limit,
      items: acts.slice((page - 1) * limit, page * limit).map((a) => ({
        ...feedItem(a, names, groupName),
        completed: a.completed ?? '',
        pending: a.pending ?? '',
        nextPriority: a.nextPriority ?? '',
        comment: a.comment ?? '',
        counts: (a.values ?? []).map((v) => ({ metric: metricInfo.get(idOf(v.metricId))?.name ?? 'Activity', value: v.value, details: v.details ?? '' })),
      })),
    });
  } catch (error) {
    fail(res, 500, error.message);
  }
};

// ── Performance ──────────────────────────────────────────────────────────────

// @route GET /api/marketing/team/performance?from&to&brand&memberId
export const getPerformance = async (req, res) => {
  try {
    const range = parseRange(req);
    if (range.error) return fail(res, 400, range.error);
    const brand = parseBrand(req);
    if (!brand) return fail(res, 400, 'Brand must be all, main or kerala.');
    const scope = await loadScope(req, range);
    if (scope.error) return fail(res, scope.error.status, scope.error.message);
    const { from, to, today } = range;
    const members = await withRoles(scope.members, to.slice(0, 7));
    const { ctx } = await loadContext(members, from, to);
    const [acts, tasks] = await Promise.all([loadActivities(members, from, to, brand), loadTasks(members, from, to, brand)]);
    const logged = await loadLogged(members, from, to, brand, acts);
    const days = S.eachDay(from, to);
    const items = S.buildItems({ tasks, activities: acts, from, to });
    const leads = await leadsByMember(req, members, { from, to, brand });
    const byId = new Map(members.map((m) => [idOf(m), m]));
    const rows = S.performanceRows({ members, items, tasks, logged, days, today, ctx, from, to }).map((r) => ({
      ...r,
      // lead → booking: the leads assigned to the member's login that arrived in the range, and how many are booked (the Lead Report's rules)
      leads: leads.get(r.memberId)?.leads ?? null,
      booked: leads.get(r.memberId)?.booked ?? null,
      leadToBooking: leads.get(r.memberId)?.rate ?? null,
      trend: S.memberWeeklyTrend({ member: byId.get(r.memberId), tasks, logged, from, to, today, ctx }),
    }));
    const team = S.activityRate({ members, days, logged, today, ctx });
    const withLeads = [...leads.values()];
    const teamLeads = withLeads.reduce((sum, x) => sum + x.leads, 0);
    const teamBooked = withLeads.reduce((sum, x) => sum + x.booked, 0);
    res.json({
      from, to,
      kpis: {
        activityRate: team.pct,
        tasksCompleted: S.kpiCounts(items).completed,
        onTimeDelivery: S.onTimeRate({ tasks, from, to }),
        leads: withLeads.length ? teamLeads : null,
        leadToBooking: teamLeads > 0 ? Math.round((teamBooked / teamLeads) * 1000) / 10 : null,
      },
      rows,
      trend: S.weeklyPerformance({ tasks, from, to }),
    });
  } catch (error) {
    fail(res, 500, error.message);
  }
};

/**
 * Map<memberId, { leads, booked, rate }> — the CRM leads assigned to each member's login, counted by the Lead Report's rules
 * (utils/marketingTeamLeads.js). Members with no login are left out (their figures read "—"). The viewer's own lead visibility applies.
 */
const leadsByMember = async (req, members, { from, to, brand }) => {
  const linked = members.filter((m) => m.userId);
  if (!linked.length) return new Map();
  const userIds = linked.map((m) => m.userId);
  const scope = await leadScopeFor(req.user);
  const leads = await loadLeadWindow({ from, to }, { ...scope, ...(scope.assignedTo ? {} : { assignedTo: { $in: userIds } }) });
  const ctx = await bookingContext(leads);
  const byUser = leadConversionByUser({ leads, userIds, from, to, brand, ctx });
  return new Map(linked.map((m) => [idOf(m), byUser.get(idOf(m.userId))]));
};

// ── Attendance ───────────────────────────────────────────────────────────────

// @route GET /api/marketing/team/attendance?date&brand&memberId
// Who is in the Office, On Shoot, Working From Home, On Leave or not in yet on a day, and each person's attendance rate for the month up to
// that day. The member filter narrows the people (a member only ever sees themself); the brand narrows the logs read for the day (a shoot
// logged for that brand puts its member On Shoot), not the people — the same person works for both brands.
export const getTeamAttendance = async (req, res) => {
  try {
    const today = toDateStr();
    const date = req.query.date ?? today;
    if (!isDay(date)) return fail(res, 400, 'The date must be YYYY-MM-DD.');
    const brand = parseBrand(req);
    if (!brand) return fail(res, 400, 'Brand must be all, main or kerala.');
    const monthStart = `${date.slice(0, 7)}-01`;
    const scope = await loadScope(req, { from: monthStart, to: date });
    if (scope.error) return fail(res, scope.error.status, scope.error.message);
    const members = await withRoles(scope.members, date.slice(0, 7));
    const { ctx, employeeOf, employeeIds } = await loadContext(members, monthStart, date);
    const att = await attendanceByEmployee(employeeIds, date);
    // Timebox, the company's attendance software: the day's punches and plans, and the month as Timebox counts it (services/marketingTimebox.js)
    const tb = await marketingTimebox(members, monthStart, date, ['days', 'summary', 'plans']);
    const acts = await MarketingActivity.find({ memberId: { $in: members.map((m) => m._id) }, entryDate: date, ...brandQuery(brand) }).lean();
    const monthModes = members.length ? await MarketingWorkMode.find({ memberId: { $in: members.map((m) => m._id) }, day: { $gte: monthStart, $lte: date } }).select('memberId day mode').lean() : [];
    const modes = new Map(monthModes.filter((x) => x.day === date).map((x) => [idOf(x.memberId), x.mode]));
    const states = S.memberStates({ members, date, activities: acts, attendanceByEmployee: att, leaves: ctx.leaves, employeeOf, modes, timebox: timeboxDay(tb, date) });

    // the month's rate, per person and for the team: attended days ÷ days expected (up to the chosen day) — utils/marketingTeamStats.js
    const attended = new Set(monthModes.map((x) => `${idOf(x.memberId)}|${x.day}`));
    const tracked = new Set(monthModes.map((x) => idOf(x.memberId)));
    if (employeeIds.length) {
      const month = await Attendance.find({ employeeId: { $in: employeeIds }, date: { $gte: istStart(monthStart), $lt: istEnd(date) } }).select('employeeId date status').lean();
      const memberOfEmployee = new Map(members.map((m) => [employeeOf(m), idOf(m)]).filter(([e]) => e));
      for (const r of month) {
        const mid = memberOfEmployee.get(idOf(r.employeeId));
        if (mid && ['Present', 'Late', 'Half-Day'].includes(r.status)) attended.add(`${mid}|${S.istDay(r.date)}`);
      }
      for (const m of members) if (employeeOf(m)) tracked.add(idOf(m));
    }
    const rates = S.attendanceRates({ members, days: S.eachDay(monthStart, date), today, ctx, attended, tracked, timeboxMonth: tb.status.ok ? tb.summary : new Map() });
    const setting = await getCalendarSetting();
    const own = scope.own ? idOf(scope.own) : '';
    const manager = isManager(req.user);
    res.json({
      date,
      brand,
      summary: S.attendanceSummary(states),
      rate: rates.team,
      linked: employeeIds.length,
      timebox: timeboxView(tb),
      // who may set a work mode for this day from the board: themself (inside the edit window) or, for a manager, anyone
      canSetOwn: !!own && date <= today && S.daysBetween(date, today) <= (setting.editWindowDays ?? 2),
      canSetOthers: manager && date <= today,
      rows: members.map((m) => {
        const st = states.get(idOf(m)) ?? {};
        const r = rates.byMember.get(idOf(m)) ?? {};
        const link = tb.links.get(idOf(m));
        const plan = tb.status.ok ? tb.plans.get(`${idOf(m)}|${date}`) ?? null : null;
        return {
          memberId: idOf(m), name: m.name, role: m.roleName, checkIn: st.checkIn, checkOut: st.checkOut, hours: st.hours, workMode: st.workMode, modeSet: !!st.modeSet, state: st.state, status: st.status,
          monthRate: r.pct ?? null, daysAttended: r.expected ? r.attended : null, daysExpected: r.expected || null, self: idOf(m) === own,
          // where the row's attendance comes from: 'timebox' (exact), 'crm' (the CRM's own record), 'logs' (only a work log) or '' (nothing)
          source: st.source ?? '', stillIn: !!st.stillIn, timeboxLink: link?.via ?? '', monthSource: r.source ?? '',
          plan: plan ? { total: plan.total, done: plan.done } : null,
        };
      }),
    });
  } catch (error) {
    fail(res, 500, error.message);
  }
};

// @route PUT /api/marketing/team/work-mode  { day?, mode: 'office' | 'on_shoot' | 'wfh' | null, memberId?, note? }
// A member says how they are working on a day (today by default): in the Office, On Shoot or From Home — HR attendance has no such field and
// a member working from home has no office check-in. `mode: null` takes it back. A member sets their own (inside the log edit window); the
// Marketing Manager / admin can set anyone's. (Leaders read only — the CEO guard.)
export const setWorkMode = async (req, res) => {
  try {
    const today = toDateStr();
    const day = req.body?.day ?? today;
    if (!isDay(day)) return fail(res, 400, 'The date must be YYYY-MM-DD.', { field: 'day' });
    if (day > today) return fail(res, 400, 'You cannot set a work mode for a future day.', { field: 'day' });
    if (!req.body || !('mode' in req.body)) return fail(res, 400, 'Choose Office, On Shoot or Work From Home.', { field: 'mode' });
    const mode = req.body.mode === null || req.body.mode === '' ? null : String(req.body.mode);
    if (mode !== null && !S.WORK_MODES.includes(mode)) return fail(res, 400, 'Choose Office, On Shoot or Work From Home.', { field: 'mode' });
    const who = await memberForWrite(req, req.body?.memberId ? String(req.body.memberId) : '');
    if (who.error) return fail(res, who.error.status, who.error.message);
    const { member } = who;
    const manager = isManager(req.user);
    const setting = await getCalendarSetting();
    const window = setting.editWindowDays ?? 2;
    if (!manager && S.daysBetween(day, today) > window) return fail(res, 403, `You can set your work mode for ${window} days back. Ask the Marketing Manager for older days.`);
    if (await monthLocked(member._id, day)) return fail(res, 403, 'This month is closed. A manager has to reopen it first.');
    if (mode === null) {
      await MarketingWorkMode.deleteOne({ memberId: member._id, day });
    } else {
      await MarketingWorkMode.findOneAndUpdate(
        { memberId: member._id, day },
        { $set: { mode, note: String(req.body?.note ?? '').trim().slice(0, 200), setBy: req.user._id } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
    }
    res.json({ memberId: idOf(member), day, mode });
  } catch (error) {
    fail(res, 500, error.message);
  }
};

// ── Tasks & Deliverables ─────────────────────────────────────────────────────

const taskView = (t, names, groupName, c = null) => ({
  id: idOf(t),
  // 'task' (a Team Dashboard task) or 'request' (a Coordinations request given to the member — changed in Coordinations)
  source: t.source ?? 'task',
  requestStatus: t.requestStatus ?? null,
  link: t.source === 'request' ? '/marketing/coordinations?tab=requests' : null,
  createdByMe: !!c && idOf(t.createdBy) === c.userId,
  canEdit: t.source === 'request' ? false : !c || c.manager || (!!c.ownId && idOf(t.assigneeId) === c.ownId),
  title: t.title,
  description: t.description,
  assigneeId: idOf(t.assigneeId),
  assignee: names.get(idOf(t.assigneeId)) ?? '',
  brand: t.brand,
  group: groupName(idOf(t.groupId)),
  groupId: t.groupId ? idOf(t.groupId) : null,
  projectLabel: t.projectLabel,
  projectId: t.projectId ? idOf(t.projectId) : null,
  isDeliverable: !!t.isDeliverable,
  initiativeId: t.initiativeId ? idOf(t.initiativeId) : null,
  devProjectId: t.devProjectId ? idOf(t.devProjectId) : null,
  dueDate: t.dueDate,
  priority: t.priority,
  status: t.status,
  progress: t.progress,
  completedAt: t.completedAt,
  attachments: t.attachments ?? [],
  comments: (t.comments ?? []).map((c) => ({ by: c.byName, text: c.text, at: c.at })),
  overdue: t.status !== 'completed' && !!t.dueDate && t.dueDate < toDateStr(),
});

// @route GET /api/marketing/team/tasks?status&priority&assigneeId&brand&q&from&to&scope=all|mine|assigned_by_me
// The team's tasks AND the Coordinations requests given to its members (read as tasks — one record, read by both screens; a request is
// changed in Coordinations). scope: mine = given to me · assigned_by_me = the ones I made (for someone else or myself) · all (a member
// only ever sees their own). With from & to the list is what matters for the range — open now, completed in it, or due in it — the same
// rule as the dashboard's counts, so an overdue task from before the range never disappears.
export const listTasks = async (req, res) => {
  try {
    const brand = parseBrand(req);
    if (!brand) return fail(res, 400, 'Brand must be all, main or kerala.');
    const own = await findOwnMember(req.user);
    const viewer = canViewTeam(req.user);
    if (!viewer && !own) return fail(res, 403, 'You are not on the Marketing team.');
    const scope = ['mine', 'assigned_by_me'].includes(req.query.scope) ? req.query.scope : 'all';
    const hasRange = req.query.from && req.query.to && isDay(req.query.from) && isDay(req.query.to);
    const from = hasRange ? req.query.from : null;
    const to = hasRange ? req.query.to : null;
    if (hasRange && to < from) return fail(res, 400, 'The end date is before the start date.');
    const who = {};
    if (!viewer || scope === 'mine') {
      if (!own) return fail(res, 403, 'You are not on the Marketing team.');
      who.assigneeId = own._id;
    } else if (req.query.assigneeId && mongoose.isValidObjectId(req.query.assigneeId)) who.assigneeId = new mongoose.Types.ObjectId(String(req.query.assigneeId));
    if (scope === 'assigned_by_me') who.createdBy = req.user._id;
    const taskFilter = { ...who, ...brandQuery(brand), ...(hasRange ? { $or: taskRangeOr(from, to) } : {}) };
    const [taskDocs, requestTasks] = await Promise.all([
      MarketingTask.find(taskFilter).sort({ dueDate: 1, createdAt: -1 }).limit(500).lean(),
      loadRequestTasks({ ...who, assigneeId: who.assigneeId ?? { $ne: null } }, from, to, brand),
    ]);
    let tasks = [...taskDocs, ...requestTasks];
    if (req.query.status && req.query.status !== 'all') tasks = tasks.filter((t) => t.status === req.query.status);
    if (req.query.priority && req.query.priority !== 'all') tasks = tasks.filter((t) => t.priority === req.query.priority);
    if (req.query.q) {
      const rx = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      tasks = tasks.filter((t) => rx.test(t.title ?? ''));
    }
    tasks.sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || new Date(b.createdAt ?? 0) - new Date(a.createdAt ?? 0));
    const members = await MarketingTeamMember.find({ _id: { $in: tasks.map((t) => t.assigneeId) } }).select('name').lean();
    const { name: groupName } = await groupNamer();
    const names = new Map(members.map((m) => [idOf(m), m.name]));
    const counts = { all: tasks.length, requests: tasks.filter((t) => t.source === 'request').length };
    for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
    const c = { userId: idOf(req.user._id), ownId: own ? idOf(own) : '', manager: isManager(req.user) };
    res.json({ scope, from, to, counts, items: tasks.map((t) => taskView(t, names, groupName, c)) });
  } catch (error) {
    fail(res, 500, error.message);
  }
};

const notifyAssigned = async (task, member, user) => {
  if (!member?.userId) return;
  await notify({
    recipients: [member.userId],
    type: NOTIFICATION_TYPES.MARKETING_TASK,
    title: 'New marketing task',
    body: `${task.title}${task.dueDate ? ` — due ${task.dueDate}` : ''}`,
    link: '/marketing/team/tasks',
    createdBy: user._id,
    excludeUserId: user._id,
  });
};

// @route POST /api/marketing/team/tasks
export const createTask = async (req, res) => {
  try {
    const own = await findOwnMember(req.user);
    const manager = isManager(req.user);
    const input = cleanTaskInput({ ...req.body, assigneeId: req.body.assigneeId ?? (own ? idOf(own) : null) });
    if (!input.ok) return fail(res, 400, input.message, { field: input.field });
    const v = input.value;
    if (!v.assigneeId) return fail(res, 400, 'Choose who the task is for.', { field: 'assigneeId' });
    if (!manager && (!own || v.assigneeId !== idOf(own))) return fail(res, 403, 'Only the Marketing Manager or Admin can assign a task to someone else.');
    const member = await MarketingTeamMember.findById(v.assigneeId);
    if (!member) return fail(res, 404, 'Team member not found.');
    if (v.initiativeId && !(await StrategicInitiative.exists({ _id: v.initiativeId }))) return fail(res, 400, 'That initiative no longer exists.', { field: 'initiativeId' });
    if (v.devProjectId && !(await DevProject.exists({ _id: v.devProjectId }))) return fail(res, 400, 'That development project no longer exists.', { field: 'devProjectId' });
    const task = await MarketingTask.create({ ...v, completedAt: v.status === 'completed' ? new Date() : null, createdBy: req.user._id, lastEditedBy: req.user._id });
    await notifyAssigned(task, member, req.user);
    const { name: groupName } = await groupNamer();
    res.status(201).json(taskView(task.toObject(), new Map([[idOf(member), member.name]]), groupName));
  } catch (error) {
    fail(res, 500, error.message);
  }
};

// @route PUT /api/marketing/team/tasks/:id
export const updateTask = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 404, 'Task not found');
    const task = await MarketingTask.findById(req.params.id);
    if (!task) return fail(res, 404, 'Task not found');
    const own = await findOwnMember(req.user);
    const manager = isManager(req.user);
    const mine = own && idOf(task.assigneeId) === idOf(own);
    if (!manager && !mine) return fail(res, 403, 'You can only change your own tasks.');
    const input = cleanTaskInput(req.body, task.toObject());
    if (!input.ok) return fail(res, 400, input.message, { field: input.field });
    const v = input.value;
    const reassigned = v.assigneeId && v.assigneeId !== idOf(task.assigneeId);
    if (v.initiativeId && !(await StrategicInitiative.exists({ _id: v.initiativeId }))) return fail(res, 400, 'That initiative no longer exists.', { field: 'initiativeId' });
    if (v.devProjectId && !(await DevProject.exists({ _id: v.devProjectId }))) return fail(res, 400, 'That development project no longer exists.', { field: 'devProjectId' });
    if (reassigned && !manager) return fail(res, 403, 'Only the Marketing Manager or Admin can give a task to someone else.');
    const wasCompleted = task.status === 'completed';
    Object.assign(task, { ...v, assigneeId: v.assigneeId ?? task.assigneeId, lastEditedBy: req.user._id });
    if (v.status === 'completed' && !wasCompleted) task.completedAt = new Date();
    if (v.status !== 'completed' && wasCompleted) {
      task.completedAt = null;
      task.completedByActivityId = null;
    }
    await task.save();
    const member = await MarketingTeamMember.findById(task.assigneeId);
    if (reassigned) await notifyAssigned(task, member, req.user);
    const { name: groupName } = await groupNamer();
    res.json(taskView(task.toObject(), new Map([[idOf(task.assigneeId), member?.name ?? '']]), groupName));
  } catch (error) {
    fail(res, 500, error.message);
  }
};

// @route DELETE /api/marketing/team/tasks/:id
export const deleteTask = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 404, 'Task not found');
    const task = await MarketingTask.findById(req.params.id);
    if (!task) return fail(res, 404, 'Task not found');
    const manager = isManager(req.user);
    if (!manager && idOf(task.createdBy) !== idOf(req.user._id)) return fail(res, 403, 'Only the person who made a task, or the Marketing Manager, can delete it.');
    // logs linked to it keep their record; they just stop pointing at a task that is gone
    await MarketingActivity.updateMany({ taskId: task._id }, { $set: { taskId: null } });
    await task.deleteOne();
    res.json({ message: 'Task deleted' });
  } catch (error) {
    fail(res, 500, error.message);
  }
};

// @route POST /api/marketing/team/tasks/:id/comments  { text }
export const addTaskComment = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 404, 'Task not found');
    const task = await MarketingTask.findById(req.params.id);
    if (!task) return fail(res, 404, 'Task not found');
    const own = await findOwnMember(req.user);
    if (!isManager(req.user) && !(own && idOf(task.assigneeId) === idOf(own))) return fail(res, 403, 'You can only comment on your own tasks.');
    const text = String(req.body?.text ?? '').trim().slice(0, 1000);
    if (!text) return fail(res, 400, 'Write a comment first.');
    task.comments.push({ by: req.user._id, byName: req.user.name ?? '', text });
    await task.save();
    res.status(201).json({ comments: task.comments.map((c) => ({ by: c.byName, text: c.text, at: c.at })) });
  } catch (error) {
    fail(res, 500, error.message);
  }
};

// ── Reports ──────────────────────────────────────────────────────────────────

const REPORTS = ['daily', 'weekly', 'monthly', 'performance', 'project', 'activity'];

// @route GET /api/marketing/team/reports/:type?from&to&brand&memberId&day&month
// Rows for the report (the app turns them into a CSV / print). Every figure comes from the same logs and tasks as the dashboard.
export const getReport = async (req, res) => {
  try {
    const type = req.params.type;
    if (!REPORTS.includes(type)) return fail(res, 404, 'Unknown report.');
    const range = parseRange(req);
    if (range.error) return fail(res, 400, range.error);
    const brand = parseBrand(req);
    if (!brand) return fail(res, 400, 'Brand must be all, main or kerala.');
    const scope = await loadScope(req, range);
    if (scope.error) return fail(res, scope.error.status, scope.error.message);
    const { from, to } = S.reportWindow(type, range, req.query);
    if (type === 'daily' && to > range.today) return fail(res, 400, 'The daily report cannot be for a future day.');
    const { today } = range;
    const members = await withRoles(scope.members, to.slice(0, 7));
    const { groups, name: groupName } = await groupNamer();
    const names = new Map(members.map((m) => [idOf(m), m.name]));
    const { ctx } = await loadContext(members, from, to);
    const [acts, tasks] = await Promise.all([loadActivities(members, from, to, brand), loadTasks(members, from, to, brand)]);
    const logged = await loadLogged(members, from, to, brand, acts);
    const days = S.eachDay(from, to);
    const items = S.buildItems({ tasks, activities: acts, from, to });
    const metricIds = [...new Set(acts.flatMap((a) => (a.values ?? []).map((v) => idOf(v.metricId))))];
    const metricName = new Map((await MarketingMetric.find({ _id: { $in: metricIds } }).select('name').lean()).map((m) => [idOf(m), m.name]));
    let columns;
    let rows;
    let title;
    if (type === 'daily' || type === 'activity') {
      title = type === 'daily' ? `Daily report — ${from}` : `Activity log — ${from} to ${to}`;
      columns = ['Date', 'Time', 'Member', 'Brand', 'Worked on', 'Project / client', 'Status', 'Minutes', 'Counts', 'Completed', 'Pending', 'Next priority'];
      rows = [...acts].sort((a, b) => a.entryDate.localeCompare(b.entryDate) || new Date(a.loggedAt) - new Date(b.loggedAt)).map((a) => [
        a.entryDate, new Date(a.loggedAt).toISOString().slice(11, 16), names.get(idOf(a.memberId)) ?? '', a.brand, a.workedOn, a.projectLabel, a.status, a.timeSpentMinutes,
        (a.values ?? []).map((v) => `${metricName.get(idOf(v.metricId)) ?? 'Activity'}: ${v.value}`).join('; '), a.completed, a.pending, a.nextPriority,
      ]);
    } else if (type === 'weekly') {
      title = `Weekly report — ${from} to ${to}`;
      columns = ['Member', 'Role', 'Logs', 'Hours', 'Days logged', 'Tasks in scope', 'Completed', 'Activity rate %'];
      const ts = S.timesheet({ members, activities: acts, groupName });
      rows = members.map((m) => {
        const t = ts.rows.find((r) => r.memberId === idOf(m));
        const mine = items.filter((i) => i.memberId === idOf(m));
        return [m.name, m.roleName, t.logs, Math.round((t.minutes / 60) * 10) / 10, t.daysLogged, mine.length, mine.filter((i) => i.status === 'completed').length, S.activityRate({ members: [m], days, logged, today, ctx }).pct ?? ''];
      });
    } else if (type === 'monthly') {
      title = `Monthly report — ${from.slice(0, 7)}`;
      columns = ['Member', 'Role', 'Days logged', 'Days expected', 'Activity rate %', 'Hours', 'Logs', 'Tasks in scope', 'Completed', 'On-time %', 'Top activities'];
      const ts = S.timesheet({ members, activities: acts, groupName });
      rows = members.map((m) => {
        const t = ts.rows.find((r) => r.memberId === idOf(m));
        const mine = items.filter((i) => i.memberId === idOf(m));
        const rate = S.activityRate({ members: [m], days, logged, today, ctx });
        const totals = new Map();
        for (const a of acts.filter((x) => idOf(x.memberId) === idOf(m))) for (const v of a.values ?? []) totals.set(idOf(v.metricId), (totals.get(idOf(v.metricId)) ?? 0) + (Number(v.value) || 0));
        const top = [...totals.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([id, n]) => `${metricName.get(id) ?? 'Activity'}: ${n}`).join('; ');
        const onTime = S.onTimeRate({ tasks: tasks.filter((x) => idOf(x.assigneeId) === idOf(m)), from, to });
        return [m.name, m.roleName, t.daysLogged, rate.expected, rate.pct ?? '', Math.round((t.minutes / 60) * 10) / 10, t.logs, mine.length, mine.filter((i) => i.status === 'completed').length, onTime ?? '', top];
      });
    } else if (type === 'performance') {
      title = `Performance — ${from} to ${to}`;
      columns = ['Member', 'Role', 'Task completion %', 'On-time %', 'Activity rate %', 'Overall %'];
      rows = S.performanceRows({ members, items, tasks, logged, days, today, ctx, from, to }).map((r) => [r.name, r.role, r.completion ?? '', r.onTime ?? '', r.activityRate ?? '', r.overall ?? '']);
    } else {
      title = `Project report — ${from} to ${to}`;
      columns = ['Project / client', 'Logs', 'Hours', 'Tasks', 'Completed'];
      const byProject = new Map();
      const row = (k) => byProject.get(k) ?? byProject.set(k, { logs: 0, minutes: 0, tasks: 0, done: 0 }).get(k);
      for (const a of acts) {
        const r = row(a.projectLabel || '(no project)');
        r.logs += 1;
        r.minutes += a.timeSpentMinutes || 0;
      }
      for (const t of tasks) {
        const r = row(t.projectLabel || '(no project)');
        r.tasks += 1;
        if (t.status === 'completed') r.done += 1;
      }
      rows = [...byProject.entries()].map(([k, r]) => [k, r.logs, Math.round((r.minutes / 60) * 10) / 10, r.tasks, r.done]).sort((a, b) => b[1] - a[1]);
    }
    void groups;
    res.json({ type, title, from, to, brand, generatedAt: new Date(), columns, rows });
  } catch (error) {
    fail(res, 500, error.message);
  }
};
