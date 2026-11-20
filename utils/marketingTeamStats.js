// What the Marketing Team Dashboard shows, worked out from the team's LOGS and TASKS. Pure — no database (tests/marketingTeamStats.test.js);
// controllers/marketingTeamController.js loads the records and calls these.
//
// The definitions (so every number can be explained and checked):
//   work item        a task record (once, however many logs touch it) + every log entry that is NOT linked to a task and is not a meeting.
//                    "Log once": a log linked to a task completes THAT task; it is never counted as a second item.
//   completed        a work item finished in the date range (a task by its completion day, a log by its day)
//   in progress      a work item in progress NOW (tasks) / logged in progress in the range (logs)
//   pending/blocked  tasks pending or blocked now / logs pending or blocked in the range
//   on-time delivery completed TASKS (with a due date) finished on or before their due day, ÷ completed tasks with a due date
//   activity rate    member-days that have a log (an EOD day entry) ÷ member-days that were expected to have one: working days up to
//                    today, inside the member's active window, outside approved leave, not a holiday or the weekly off
//   member state     On Leave (approved leave) > the work mode the member set for the day (Office → Active, On Shoot, Work From Home)
//                    > On Shoot (a shoot log in progress that day) > Active (attendance or a log) > Not in yet
//   coordination     a Coordinations request (CoordRequest) GIVEN TO a team member is that member's work too: it is read as a task
//   request          (requestAsTask) — open → not started, in progress → in progress, waiting input / in review / pending approval →
//                    pending, completed → completed (on the day it was closed), cancelled → not counted. So closing it in Coordinations
//                    moves the Team Dashboard's counts, and nothing is typed twice.
//   attendance rate  per member: days attended ÷ days expected (up to today). A day is attended when HR attendance says Present / Late /
//                    Half-Day, or the member set a work mode for it (Office, On Shoot, Work From Home). A member with no HR login linked
//                    and no work mode set in the period has no rate ("—"), never 0.

const DAY = 86_400_000;
const IST = 5.5 * 60 * 60 * 1000;

/** The IST day (YYYY-MM-DD) of a moment. */
export const istDay = (date = new Date()) => new Date(new Date(date).getTime() + IST).toISOString().slice(0, 10);

const utc = (day) => {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
export const addDays = (day, n) => new Date(utc(day) + n * DAY).toISOString().slice(0, 10);
export const daysBetween = (from, to) => Math.round((utc(to) - utc(from)) / DAY);

/** Every day from `from` to `to`, inclusive (empty when `to` is before `from`); capped so a wild range cannot hang the server. */
export const eachDay = (from, to, cap = 400) => {
  const out = [];
  for (let d = from; d <= to && out.length < cap; d = addDays(d, 1)) out.push(d);
  return out;
};

/** The period of the same length immediately before `range`. */
export const previousRange = ({ from, to }) => {
  const len = daysBetween(from, to) + 1;
  return { from: addDays(from, -len), to: addDays(from, -1) };
};

const pct = (num, den) => (den > 0 ? Math.round((num / den) * 100) : null);
const round1 = (n) => Math.round(n * 10) / 10;
const idOf = (v) => (v == null ? '' : String(v._id ?? v));

export const normalizeStatus = (s) => (['completed', 'in_progress', 'pending', 'blocked', 'not_started'].includes(s) ? s : 'in_progress');

// ── work items ───────────────────────────────────────────────────────────────

/**
 * The work items for [from, to]: tasks open now or completed in the range, and the in-range logs that are not linked to a task
 * (and not meetings).
 */
export const buildItems = ({ tasks = [], activities = [], from, to }) => {
  const items = [];
  for (const t of tasks) {
    const status = normalizeStatus(t.status);
    const completedDay = t.completedAt ? istDay(t.completedAt) : null;
    if (status === 'completed') {
      if (!completedDay || completedDay < from || completedDay > to) continue;
    }
    items.push({ source: t.source ?? 'task', id: idOf(t._id), memberId: idOf(t.assigneeId), groupId: idOf(t.groupId), status, due: t.dueDate || null, completedDay, brand: t.brand });
  }
  for (const a of activities) {
    if (a.taskId || a.kind === 'meeting') continue;
    if (a.entryDate < from || a.entryDate > to) continue;
    const status = normalizeStatus(a.status);
    items.push({ source: 'log', id: idOf(a._id), memberId: idOf(a.memberId), groupId: idOf(a.groupId), status, due: null, completedDay: status === 'completed' ? a.entryDate : null, brand: a.brand });
  }
  return items;
};

/** How a Coordinations request's status reads on the Team Dashboard (null: cancelled — it counts nowhere). */
export const REQUEST_STATUS_AS_TASK = { open: 'not_started', in_progress: 'in_progress', waiting_input: 'pending', in_review: 'pending', pending_approval: 'pending', completed: 'completed' };

/**
 * A Coordinations request given to a team member, read as one of their tasks (see "coordination request" above): the same shape the
 * task functions here take, marked `source: 'request'`. Null when it cannot count (cancelled, or given to nobody on the team).
 * `groupId` is the activity group coordination work counts under (the "Coordination" group, when there is one).
 */
export const requestAsTask = (r, { groupId = null } = {}) => {
  const status = REQUEST_STATUS_AS_TASK[r.status];
  if (!status || !r.assigneeId) return null;
  return {
    _id: r._id ?? r.id,
    source: 'request',
    title: r.title,
    description: r.detail ?? '',
    assigneeId: r.assigneeId,
    groupId,
    brand: r.brand ?? 'main',
    projectLabel: r.fromDept && r.toDept ? `${r.fromDept} → ${r.toDept}` : '',
    dueDate: r.dueDate ?? null,
    priority: r.priority ?? 'medium',
    status,
    requestStatus: r.status,
    progress: status === 'completed' ? 100 : Math.max(0, Math.min(100, Math.round(Number(r.progress) || 0))),
    completedAt: status === 'completed' ? r.closedAt ?? null : null,
    createdBy: r.createdBy ?? null,
    createdAt: r.createdAt ?? null,
  };
};

/** The group a log counts under: the one the form chose, else the group of its biggest count, else the group of the task it is for. */
export const pickGroup = ({ chosen = null, countGroup = null, taskGroup = null }) => chosen || countGroup || taskGroup || null;

export const kpiCounts = (items) => ({
  completed: items.filter((i) => i.status === 'completed').length,
  inProgress: items.filter((i) => i.status === 'in_progress').length,
  pendingBlocked: items.filter((i) => i.status === 'pending' || i.status === 'blocked').length,
});

/** Percentage change of [now] against [before] (null when there is nothing to compare with). */
export const changePct = (now, before) => (before > 0 ? Math.round(((now - before) / before) * 100) : null);

/** Completed tasks with a due date, delivered on or before it (null when none were due). */
export const onTimeRate = ({ tasks = [], from, to }) => {
  const done = tasks.filter((t) => normalizeStatus(t.status) === 'completed' && t.dueDate && t.completedAt && istDay(t.completedAt) >= from && istDay(t.completedAt) <= to);
  if (!done.length) return null;
  return pct(done.filter((t) => istDay(t.completedAt) <= t.dueDate).length, done.length);
};

// ── expected days and the activity rate ──────────────────────────────────────

/**
 * Is this day one the member was expected to log? `ctx`: { weeklyOff (0=Sunday), holidays: Set<day>, leaves: Map<memberId, Set<day>> }.
 */
export const isExpectedDay = (member, day, ctx = {}) => {
  const from = member.activeFrom ? istDay(member.activeFrom) : null;
  const to = member.activeTo ? istDay(member.activeTo) : null;
  if (from && day < from) return false;
  if (to && day > to) return false;
  if (new Date(utc(day)).getUTCDay() === (ctx.weeklyOff ?? 0)) return false;
  if (ctx.holidays?.has(day)) return false;
  if (ctx.leaves?.get(idOf(member._id))?.has(day)) return false;
  return true;
};

/** { expected, actual, pct } — member-days with a log ÷ member-days expected, up to `today`. `logged`: Set of "memberId|day". */
export const activityRate = ({ members = [], days = [], logged = new Set(), today, ctx = {} }) => {
  let expected = 0;
  let actual = 0;
  for (const m of members) {
    for (const d of days) {
      if (d > today) continue;
      if (!isExpectedDay(m, d, ctx)) continue;
      expected += 1;
      if (logged.has(`${idOf(m._id)}|${d}`)) actual += 1;
    }
  }
  return { expected, actual, pct: pct(actual, expected) };
};

// ── tables and charts ────────────────────────────────────────────────────────

/** One row per member: tasks in scope, how many are done, progress %. */
export const memberRows = ({ members = [], items = [], states = new Map() }) =>
  members.map((m) => {
    const mine = items.filter((i) => i.memberId === idOf(m._id));
    const done = mine.filter((i) => i.status === 'completed').length;
    const st = states.get(idOf(m._id)) ?? {};
    return { memberId: idOf(m._id), name: m.name, shortName: m.shortName, role: m.roleName ?? '', tasks: mine.length, completed: done, progress: pct(done, mine.length) ?? 0, state: st.state ?? 'Not in yet' };
  });

/** Work items per group: { group, count, pct } (no group → "Others"), biggest first. */
export const workloadByGroup = (items, groupName) => {
  const counts = new Map();
  for (const i of items) {
    const g = groupName(i.groupId) || 'Others';
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  const total = items.length;
  return [...counts.entries()].map(([group, count]) => ({ group, count, pct: pct(count, total) ?? 0 })).sort((a, b) => b.count - a.count || a.group.localeCompare(b.group));
};

/** Per group: how much of its work is completed. */
export const progressByGroup = (items, groupName) => {
  const by = new Map();
  for (const i of items) {
    const g = groupName(i.groupId) || 'Others';
    const row = by.get(g) ?? { group: g, total: 0, completed: 0 };
    row.total += 1;
    if (i.status === 'completed') row.completed += 1;
    by.set(g, row);
  }
  return [...by.values()].map((r) => ({ ...r, pct: pct(r.completed, r.total) ?? 0 })).sort((a, b) => b.pct - a.pct || a.group.localeCompare(b.group));
};

/** Per day: items completed that day, and the % of expected members who logged. */
export const dailyTrend = ({ days = [], items = [], members = [], logged = new Set(), today, ctx = {} }) =>
  days.map((day) => {
    const completed = items.filter((i) => i.status === 'completed' && i.completedDay === day).length;
    let expected = 0;
    let actual = 0;
    for (const m of members) {
      if (day > today || !isExpectedDay(m, day, ctx)) continue;
      expected += 1;
      if (logged.has(`${idOf(m._id)}|${day}`)) actual += 1;
    }
    return { day, completed, activityPct: pct(actual, expected) };
  });

// ── attendance ───────────────────────────────────────────────────────────────

const PRESENT = new Set(['Present', 'Late', 'Half-Day']);

/** The work modes a member can set for a day (models/MarketingWorkMode.js). */
export const WORK_MODES = ['office', 'on_shoot', 'wfh'];
const MODE_STATE = { office: 'Active', on_shoot: 'On Shoot', wfh: 'Work From Home' };

/**
 * Each member's state on `date`. Inputs: attendance by employeeId ({status, checkInTime, checkOutTime}), leave days by memberId,
 * the day's activities, and the work mode each member set for the day (Map<memberId, 'office' | 'on_shoot' | 'wfh'>).
 * `timebox` ({ linked: Set<memberId>, days: Map<memberId, Timebox day> }, services/marketingTimebox.js): for a member linked to Timebox,
 * presence, check-in / out and hours are Timebox's EXACTLY — a work log no longer counts as being in, and the CRM's attendance is not read.
 * → Map<memberId, { state, workMode, modeSet, checkIn, checkOut, hours, status, source, stillIn }>.
 */
export const memberStates = ({ members = [], date, activities = [], attendanceByEmployee = new Map(), leaves = new Map(), employeeOf = () => '', modes = new Map(), timebox = null }) => {
  const out = new Map();
  for (const m of members) {
    const id = idOf(m._id);
    const tbLinked = !!timebox?.linked?.has(id);
    const tb = tbLinked ? timebox.days?.get(id) ?? null : null;
    const att = tbLinked ? null : attendanceByEmployee.get(employeeOf(m));
    const todays = activities.filter((a) => idOf(a.memberId) === id && a.entryDate === date);
    const onLeave = leaves.get(id)?.has(date) ?? false;
    const mode = WORK_MODES.includes(modes.get(id)) ? modes.get(id) : null;
    const onShoot = todays.some((a) => a.kind === 'shoot' && a.status === 'in_progress');
    const present = tbLinked ? !!tb?.loginAt : (att && PRESENT.has(att.status)) || todays.length > 0;
    let state = 'Not in yet';
    let workMode = '';
    if (onLeave) {
      state = 'On Leave';
      workMode = 'on_leave';
    } else if (mode) {
      state = MODE_STATE[mode];
      workMode = mode;
    } else if (onShoot) {
      state = 'On Shoot';
      workMode = 'on_shoot';
    } else if (present) {
      state = 'Active';
      workMode = 'office';
    }
    if (tbLinked) {
      out.set(id, {
        state,
        workMode,
        modeSet: !!mode && !onLeave,
        checkIn: tb?.loginAt ?? null,
        checkOut: tb?.logoutAt ?? null,
        // Timebox's own hours (after lunch); none while still in
        hours: tb?.workedMinutes != null ? round1(tb.workedMinutes / 60) : null,
        status: tb ? (tb.stillIn ? 'In' : 'Out') : onLeave ? 'On Leave' : mode ? 'Set by member' : 'Not punched in',
        source: 'timebox',
        stillIn: !!tb?.stillIn,
      });
      continue;
    }
    const inAt = att?.checkInTime ?? null;
    const outAt = att?.checkOutTime ?? null;
    const hours = inAt && outAt ? round1((new Date(outAt) - new Date(inAt)) / 3_600_000) : null;
    out.set(id, { state, workMode, modeSet: !!mode && !onLeave, checkIn: inAt, checkOut: outAt, hours, status: att?.status ?? (todays.length ? 'Logged' : onLeave ? 'On Leave' : mode ? 'Set by member' : 'Absent'), source: att ? 'crm' : todays.length ? 'logs' : '', stillIn: false });
  }
  return out;
};

export const attendanceSummary = (states) => {
  const v = [...states.values()];
  return {
    present: v.filter((s) => s.state === 'Active').length,
    onShoot: v.filter((s) => s.state === 'On Shoot').length,
    wfh: v.filter((s) => s.state === 'Work From Home').length,
    onLeave: v.filter((s) => s.state === 'On Leave').length,
    absent: v.filter((s) => s.state === 'Not in yet').length,
  };
};

/**
 * The attendance rate of each member and of the team, up to `today` (see "attendance rate" above).
 * `attended`: Set of "memberId|day" (HR present, or a work mode set); `tracked`: Set of memberIds that can have a rate at all (an HR
 * login linked, or a work mode set in the period). `timeboxMonth`: Map<memberId, Timebox month> — a member in it takes Timebox's figures.
 * → { team: pct | null, byMember: Map<memberId, { attended, expected, pct, source? }> }
 */
export const attendanceRates = ({ members = [], days = [], today, ctx = {}, attended = new Set(), tracked = new Set(), timeboxMonth = new Map() }) => {
  const byMember = new Map();
  let att = 0;
  let exp = 0;
  for (const m of members) {
    const id = idOf(m._id);
    // linked to Timebox: the month exactly as Timebox counts it (its days present, its working days, its %)
    const tb = timeboxMonth.get(id);
    if (tb) {
      byMember.set(id, { attended: tb.daysPresent, expected: tb.expectedDays, pct: tb.percent ?? pct(tb.daysPresent, tb.expectedDays), source: 'timebox' });
      att += tb.daysPresent;
      exp += tb.expectedDays;
      continue;
    }
    if (!tracked.has(id)) {
      byMember.set(id, { attended: 0, expected: 0, pct: null });
      continue;
    }
    let a = 0;
    let e = 0;
    for (const d of days) {
      if (d > today || !isExpectedDay(m, d, ctx)) continue;
      e += 1;
      if (attended.has(`${id}|${d}`)) a += 1;
    }
    byMember.set(id, { attended: a, expected: e, pct: pct(a, e) });
    att += a;
    exp += e;
  }
  return { team: pct(att, exp), byMember };
};

// ── deadlines, timesheet, performance, insights ──────────────────────────────

/** Open tasks due today or later, soonest first. */
export const upcomingDeadlines = (tasks = [], today, limit = 6) =>
  tasks
    .filter((t) => normalizeStatus(t.status) !== 'completed' && t.dueDate && t.dueDate >= today)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .slice(0, limit);

export const overdueCount = (tasks = [], today) => tasks.filter((t) => normalizeStatus(t.status) !== 'completed' && t.dueDate && t.dueDate < today).length;

/**
 * Hours per person and how the time splits across groups.
 * → { rows: [{ memberId, name, minutes, logs, daysLogged, byDay: {day: minutes}, byGroup: {group: minutes} }], totalMinutes, split: [{ group, minutes, pct }] }
 */
export const timesheet = ({ members = [], activities = [], groupName }) => {
  const rows = members.map((m) => {
    const id = idOf(m._id);
    const mine = activities.filter((a) => idOf(a.memberId) === id);
    const byDay = {};
    const byGroup = {};
    let minutes = 0;
    for (const a of mine) {
      const min = a.timeSpentMinutes || 0;
      minutes += min;
      byDay[a.entryDate] = (byDay[a.entryDate] ?? 0) + min;
      const g = groupName(idOf(a.groupId)) || 'Others';
      byGroup[g] = (byGroup[g] ?? 0) + min;
    }
    return { memberId: id, name: m.name, shortName: m.shortName, minutes, logs: mine.length, daysLogged: Object.keys(byDay).length, byDay, byGroup };
  });
  const totalMinutes = rows.reduce((s, r) => s + r.minutes, 0);
  const split = new Map();
  for (const r of rows) for (const [g, min] of Object.entries(r.byGroup)) split.set(g, (split.get(g) ?? 0) + min);
  return {
    rows,
    totalMinutes,
    split: [...split.entries()].map(([group, minutes]) => ({ group, minutes, pct: pct(minutes, totalMinutes) ?? 0 })).sort((a, b) => b.minutes - a.minutes),
  };
};

// ── Team Activity views, the work summary and the activity report ────────────

/**
 * Which project a log is for, as one key the screens can filter by: the CRM project it was tied to (`id:<projectId>`), else the
 * project or client typed (`label:<lower-case text>`), else `none`.
 */
export const projectKeyOf = (a) => {
  if (a.projectId) return `id:${idOf(a.projectId)}`;
  const label = String(a.projectLabel ?? '').trim().toLowerCase();
  return label ? `label:${label}` : 'none';
};

/**
 * The logs of the period three ways (the Team Activity tab's By Member / By Project / By Category views): per member, per project
 * (projectKeyOf) and per activity group — each row { key, label, logs, minutes, completed }, the most logs first.
 * `projectName(id)` names a CRM project; a typed project keeps the text first typed; no group → "Others".
 */
export const activityBreakdown = ({ activities = [], memberName = () => '', groupName = () => '', projectName = () => '' }) => {
  const add = (map, key, label, a) => {
    const row = map.get(key) ?? { key, label, logs: 0, minutes: 0, completed: 0 };
    row.logs += 1;
    row.minutes += a.timeSpentMinutes || 0;
    if (a.status === 'completed') row.completed += 1;
    map.set(key, row);
  };
  const byMember = new Map();
  const byProject = new Map();
  const byCategory = new Map();
  for (const a of activities) {
    add(byMember, idOf(a.memberId), memberName(idOf(a.memberId)) || 'Unknown member', a);
    const pk = projectKeyOf(a);
    add(byProject, pk, pk === 'none' ? '(no project)' : pk.startsWith('id:') ? projectName(idOf(a.projectId)) || String(a.projectLabel ?? '').trim() || 'Project' : String(a.projectLabel).trim(), a);
    const gid = idOf(a.groupId);
    const g = groupName(gid);
    add(byCategory, g ? gid : 'others', g || 'Others', a);
  }
  const sorted = (map) => [...map.values()].sort((x, y) => y.logs - x.logs || y.minutes - x.minutes || x.label.localeCompare(y.label));
  return { byMember: sorted(byMember), byProject: sorted(byProject), byCategory: sorted(byCategory) };
};

/**
 * Logs & Timesheet → Work Summary: per member, from their logs in the period — what they completed (the "What did you complete?"
 * answers, newest first; a completed log with no answer counts by what it was), what is still pending and their next priority (the
 * newest answers). → [{ memberId, name, logs, minutes, completedCount, completed: [text], pending: text, nextPriority: text, lastDay }]
 */
export const workSummary = ({ members = [], activities = [] }) =>
  members.map((m) => {
    const id = idOf(m._id);
    const mine = activities.filter((a) => idOf(a.memberId) === id).sort((a, b) => (a.entryDate === b.entryDate ? new Date(b.loggedAt ?? 0) - new Date(a.loggedAt ?? 0) : a.entryDate < b.entryDate ? 1 : -1));
    const completed = [];
    for (const a of mine) {
      const text = String(a.completed ?? '').trim() || (a.status === 'completed' ? String(a.workedOn ?? '').trim() : '');
      if (text && !completed.includes(text)) completed.push(text);
    }
    const latest = (k) => mine.map((a) => String(a[k] ?? '').trim()).find(Boolean) ?? '';
    return {
      memberId: id,
      name: m.name,
      logs: mine.length,
      minutes: mine.reduce((s, a) => s + (a.timeSpentMinutes || 0), 0),
      completedCount: mine.filter((a) => a.status === 'completed').length,
      completed: completed.slice(0, 8),
      pending: latest('pending'),
      nextPriority: latest('nextPriority'),
      lastDay: mine[0]?.entryDate ?? null,
    };
  });

/**
 * Logs & Timesheet → Activity Report: the counts the logs carry, per activity (metric) and per group, for the period.
 * `metricInfo(id)` → { name, groupId, unitType } | undefined. → { rows: [{ metricId, metric, group, unitType, total, logs, members }],
 * groups: [{ group, total, logs }] } — a group's total adds its count metrics only (money is not added to counts).
 */
export const activityReport = ({ activities = [], metricInfo = () => undefined, groupName = () => '' }) => {
  const rows = new Map();
  for (const a of activities) {
    for (const v of a.values ?? []) {
      const id = idOf(v.metricId);
      const info = metricInfo(id) ?? {};
      const row = rows.get(id) ?? { metricId: id, metric: info.name ?? 'Activity', group: groupName(idOf(info.groupId)) || 'Others', unitType: info.unitType ?? 'count', total: 0, logs: 0, members: new Set() };
      row.total += Number(v.value) || 0;
      row.logs += 1;
      row.members.add(idOf(a.memberId));
      rows.set(id, row);
    }
  }
  const list = [...rows.values()].map((r) => ({ ...r, total: Math.round(r.total * 100) / 100, members: r.members.size })).sort((a, b) => a.group.localeCompare(b.group) || b.total - a.total);
  const groups = new Map();
  for (const r of list) {
    const g = groups.get(r.group) ?? { group: r.group, total: 0, logs: 0 };
    if (r.unitType !== 'currency') g.total += r.total;
    g.logs += r.logs;
    groups.set(r.group, g);
  }
  return { rows: list, groups: [...groups.values()].sort((a, b) => b.total - a.total) };
};

/**
 * One member's trend over the period, a week at a time (7 days from `from`): their activity rate that week and, of their tasks due
 * that week, the % completed. Weeks with nothing to measure are null ("—").
 */
export const memberWeeklyTrend = ({ member, tasks = [], logged = new Set(), from, to, today, ctx = {} }) => {
  const out = [];
  const mine = tasks.filter((t) => idOf(t.assigneeId) === idOf(member._id));
  for (let start = from, n = 1; start <= to && n <= 60; start = addDays(start, 7), n += 1) {
    const end = addDays(start, 6) > to ? to : addDays(start, 6);
    const due = mine.filter((t) => t.dueDate && t.dueDate >= start && t.dueDate <= end);
    out.push({
      week: n,
      from: start,
      to: end,
      activityPct: activityRate({ members: [member], days: eachDay(start, end), logged, today, ctx }).pct,
      completion: pct(due.filter((t) => normalizeStatus(t.status) === 'completed').length, due.length),
    });
  }
  return out;
};

/** Per member: completion %, on-time %, activity rate %, and the average of those that exist. Best first. */
export const performanceRows = ({ members = [], items = [], tasks = [], logged = new Set(), days = [], today, ctx = {}, from, to }) =>
  members
    .map((m) => {
      const id = idOf(m._id);
      const mine = items.filter((i) => i.memberId === id);
      const completion = pct(mine.filter((i) => i.status === 'completed').length, mine.length);
      const onTime = onTimeRate({ tasks: tasks.filter((t) => idOf(t.assigneeId) === id), from, to });
      const rate = activityRate({ members: [m], days, logged, today, ctx }).pct;
      const parts = [completion, onTime, rate].filter((v) => v != null);
      return { memberId: id, name: m.name, shortName: m.shortName, role: m.roleName ?? '', completion, onTime, activityRate: rate, overall: parts.length ? Math.round(parts.reduce((s, v) => s + v, 0) / parts.length) : null, tasks: mine.length };
    })
    .sort((a, b) => (b.overall ?? -1) - (a.overall ?? -1) || a.name.localeCompare(b.name));

/** Weekly buckets (7 days from `from`): of the tasks due in the bucket, the % completed and the % of those completed on time. */
export const weeklyPerformance = ({ tasks = [], from, to }) => {
  const out = [];
  for (let start = from, n = 1; start <= to && n <= 60; start = addDays(start, 7), n += 1) {
    const end = addDays(start, 6) > to ? to : addDays(start, 6);
    const due = tasks.filter((t) => t.dueDate && t.dueDate >= start && t.dueDate <= end);
    const done = due.filter((t) => normalizeStatus(t.status) === 'completed');
    const onTime = done.filter((t) => t.completedAt && istDay(t.completedAt) <= t.dueDate);
    out.push({ week: n, from: start, to: end, completion: pct(done.length, due.length), onTime: pct(onTime.length, done.length), tasks: due.length });
  }
  return out;
};

/** A few plain-language lines for the "Key insights" card. */
export const insights = ({ completed, previousCompleted, activityPct, pendingBlocked, overdue, nextDeadline, periodLabel = 'the previous period' }) => {
  const out = [];
  const delta = changePct(completed, previousCompleted);
  out.push(delta == null ? `Team completed ${completed} task${completed === 1 ? '' : 's'}.` : `Team completed ${completed} task${completed === 1 ? '' : 's'} (${delta >= 0 ? '+' : '−'}${Math.abs(delta)}% against ${periodLabel}).`);
  if (activityPct != null) out.push(`Overall activity rate is ${activityPct}%.`);
  out.push(pendingBlocked > 0 ? `${pendingBlocked} task${pendingBlocked === 1 ? ' is' : 's are'} pending or blocked.` : 'Nothing is blocked.');
  if (overdue > 0) out.push(`${overdue} task${overdue === 1 ? ' is' : 's are'} overdue.`);
  if (nextDeadline) out.push(`Next deadline: ${nextDeadline.title} on ${nextDeadline.dueDate}.`);
  return out;
};

const isRealDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

/**
 * The days a Team Dashboard report covers. daily = ONE day: `query.day` when it is a real day, else today — never the first day of the
 * range (the app always sends a range); monthly = the calendar month `query.month` (YYYY-MM), else the month the range ends in; every
 * other report = the range itself.
 */
export const reportWindow = (type, { from, to, today }, query = {}) => {
  if (type === 'daily') {
    const day = isRealDay(query.day) ? query.day : today;
    return { from: day, to: day };
  }
  if (type === 'monthly') {
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(query.month ?? '')) ? String(query.month) : to.slice(0, 7);
    const first = `${month}-01`;
    return { from: first, to: addDays(`${addDays(first, 31).slice(0, 7)}-01`, -1) };
  }
  return { from, to };
};

/** Minutes as "7h 45m" (and "—" for none). */
export const hoursLabel = (minutes) => {
  if (!minutes) return '—';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`;
};
