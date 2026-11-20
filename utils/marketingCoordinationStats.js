import { istDay, addDays, daysBetween, changePct } from './marketingTeamStats.js';

// What the Coordinations screens count — one definition of each number, used by the Overview, Requests & Tasks, Inter-Department,
// Approvals, Meetings and Follow-ups so they agree. Pure: no database (tests/marketingCoordinationStats.test.js);
// controllers/marketingCoordinationsController.js loads the records and calls these. Days are IST day strings 'YYYY-MM-DD'.
//
// Records: CoordRequest (kind 'request' | 'handover'), CoordApproval, CoordMeeting, CoordFollowUp (models/Coord*.js).
//
//  REQUEST STATUS MACHINE
//    open → in_progress | completed | cancelled
//    in_progress → waiting_input | in_review | pending_approval | completed | cancelled
//    waiting_input / in_review / pending_approval → each other, in_progress, completed, cancelled
//    completed → in_progress (reopen)      cancelled → open (reopen)
//    You cannot go back to "open" once work has started. Completed and cancelled stamp `closedAt`; reopening clears it.
//
//  WHICH REQUESTS COUNT IN A DATE RANGE ("in scope"): a request that is not cancelled and was logged in the range, or was closed in the
//    range, or is still open and was logged before the range (it is carried over — an open request does not vanish because the week
//    moved on). Status is as of now (no history is kept). A cancelled request counts nowhere.
//    Approvals follow the same rule: raised in the range, decided in the range, or still awaiting a decision and raised earlier.
//
//  FIGURES (coordKpis — the ONE function behind the Overview strip and the Requests & Tasks strip; the Requests strip passes
//  includeApprovals = false because its table lists requests only)
//    total             in-scope requests (+ in-scope approvals when includeApprovals)
//    completed         requests completed (+ approvals approved)
//    inProgress        requests in status in_progress
//    pending           requests not started or paused: open, waiting_input, in_review, pending_approval
//                      (so for requests alone  total = inProgress + pending + completed)
//    pendingApprovals  approvals awaiting a decision (pending, in_review, escalated) + requests in pending_approval that no awaiting
//                      approval record is linked to (so one piece of work is never counted twice)
//    overdue           open requests (+ approvals awaiting a decision) whose due day is before today (IST)
//    onTimeRate        of the completed requests (+ decided approvals) that have a due day, the share closed on or before it;
//                      null when none has a due day
//  A request or approval logged by a member counts toward the total, the status tiles and the on-time rate — nothing is typed twice.
//
//  OTHER DEFINITIONS
//    Request by Department  groups the in-scope requests by requesting team, receiving team, or both (a request is then counted under
//                           each of its two teams); the biggest five are listed and the rest are merged into "Others".
//    Inter-Department       the handovers (kind 'handover') by stage: Requested (open), In Progress (in_progress, waiting_input),
//                           In Review (in_review, pending_approval), Completed. KPIs: active (the first three), awaiting action
//                           (open + waiting_input), in review (in_review + pending_approval), overdue, completed.
//    Approvals tabs        Pending (pending) · In Review (in_review + escalated) · Approved · Rejected. Only a Marketing Manager / admin
//                           decides; a decided approval (approved / rejected) is final. Amounts are recorded; nothing is posted to accounts.
//    Meetings              total = meetings in the range that are not cancelled; this week = the week of today; completed = marked
//                           completed; upcoming = not completed, not ended yet (upcoming or happening now). A meeting that ended and
//                           was not closed is "to close" (needs its notes), not upcoming.
//    Follow-ups            a follow-up is in scope when due in the range, or still open and overdue from before it. State: completed
//                           (done) · overdue (open, due before today) · due today · upcoming. total = completed + overdue + due today
//                           + upcoming.
//    Upcoming Coordinations  meetings that have not ended + open requests' due days, from today to the end of the period, soonest first.
//    Team tasks in the table  the Team Dashboard's tasks (MarketingTask) are listed in the task table (My / Team / All) beside the requests
//                           — one task record, read by both screens. A task reads as a request of the Marketing team to itself
//                           (taskAsRequest): not started → Open, in progress → In Progress, pending / blocked → Waiting Input,
//                           completed → Completed (closed when it was completed). It counts in a range by the same rule as a request
//                           (made in it, completed in it, or still open from before it). It is in the TABLE and its tab counts only:
//                           the headline figures, the department split and the boards stay requests and approvals.
//    Escalation             an escalated approval is sent up to the leadership (CEO / Executive Director) and the Marketing Managers;
//                           who it went to is kept on the approval (escalatedTo) and shown as "Escalated to …" (escalationLabel).
//    Follow-up reminders    a follow-up with its reminder on tells its owner once when it falls due (or, if first seen late, that it
//                           is overdue) — once per due day, stamped atomically (remindedFor), so moving the due day re-arms it.

export const DEPARTMENTS = ['Production', 'Socials', 'Marketing', 'Sales', 'Operations', 'HR', 'Finance', 'IT', 'Design', 'Others'];
export const APPROVAL_CATEGORIES = [...DEPARTMENTS, 'Brand'];
export const PRIORITIES = ['high', 'medium', 'low'];

export const REQUEST_STATUSES = ['open', 'in_progress', 'waiting_input', 'in_review', 'pending_approval', 'completed', 'cancelled'];
export const OPEN_STATUSES = ['open', 'in_progress', 'waiting_input', 'in_review', 'pending_approval'];
export const PENDING_STATUSES = ['open', 'waiting_input', 'in_review', 'pending_approval'];
export const STATUS_LABEL = { open: 'Open', in_progress: 'In Progress', waiting_input: 'Waiting Input', in_review: 'In Review', pending_approval: 'Pending Approval', completed: 'Completed', cancelled: 'Cancelled' };

export const APPROVAL_STATUSES = ['pending', 'in_review', 'approved', 'rejected', 'escalated'];
export const AWAITING_APPROVAL = ['pending', 'in_review', 'escalated'];

export const MEETING_STATUSES = ['upcoming', 'completed', 'cancelled'];
export const FOLLOWUP_STATUSES = ['open', 'done'];

const TRANSITIONS = {
  open: ['in_progress', 'completed', 'cancelled'],
  in_progress: ['waiting_input', 'in_review', 'pending_approval', 'completed', 'cancelled'],
  waiting_input: ['in_progress', 'in_review', 'pending_approval', 'completed', 'cancelled'],
  in_review: ['in_progress', 'waiting_input', 'pending_approval', 'completed', 'cancelled'],
  pending_approval: ['in_progress', 'waiting_input', 'in_review', 'completed', 'cancelled'],
  completed: ['in_progress'],
  cancelled: ['open'],
};

const idOf = (v) => (v == null ? '' : String(v._id ?? v));
const pct = (num, den) => (den > 0 ? Math.round((num / den) * 100) : null);
const brandOk = (r, brand) => !brand || brand === 'all' || (r.brand ?? 'main') === brand;
const inRange = (day, from, to) => !!day && day >= from && day <= to;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The statuses a request in [from] can be moved to (not including staying put). */
export const nextStatuses = (from) => TRANSITIONS[from] ?? [];
export const canMoveRequest = (from, to) => from === to || nextStatuses(from).includes(to);
export const isOpenStatus = (s) => OPEN_STATUSES.includes(s);

// ── dates ─────────────────────────────────────────────────────────────────────

/** The hh:mm (IST) of a moment. */
export const istTime = (date) => new Date(new Date(date).getTime() + 5.5 * 3600 * 1000).toISOString().slice(11, 16);
/** Monday–Sunday around [day]. */
export const weekRange = (day) => {
  const dow = new Date(Date.parse(`${day}T00:00:00Z`)).getUTCDay();
  const from = addDays(day, -((dow + 6) % 7));
  return { from, to: addDays(from, 6) };
};
export const monthEnd = (day) => addDays(`${addDays(`${day.slice(0, 7)}-01`, 31).slice(0, 8)}01`, -1);
/** The last day of a period that starts today: 'today' | 'week' | 'month'. */
export const periodEnd = (today, period) => (period === 'today' ? today : period === 'month' ? monthEnd(today) : weekRange(today).to);

export const createdDay = (r) => (r.createdAt ? istDay(r.createdAt) : null);
export const closedDay = (r) => (r.closedAt ? istDay(r.closedAt) : null);

// ── requests ──────────────────────────────────────────────────────────────────

/** A request's progress: completed is always 100; otherwise the stored figure, kept between 0 and 100. */
export const progressOf = (r) => (r.status === 'completed' ? 100 : Math.max(0, Math.min(100, Math.round(Number(r.progress) || 0))));

const MIN_PROGRESS = { open: 0, in_progress: 10, waiting_input: 10, in_review: 75, pending_approval: 75 };
/**
 * The progress after a status change: completing sets 100; reopening a completed request caps it at 90; moving into a stage lifts
 * the figure to at least that stage's floor (in review is never under 75%); moving back never lowers it.
 */
export const progressAfterMove = (from, to, current) => {
  const now = Math.max(0, Math.min(100, Math.round(Number(current) || 0)));
  if (to === 'completed') return 100;
  if (to === 'cancelled') return now;
  const base = from === 'completed' ? Math.min(now, 90) : now;
  return Math.max(base, MIN_PROGRESS[to] ?? 0);
};

export const deptOk = (dept, ...depts) => !dept || dept === 'all' || depts.some((d) => d === dept);

export const isOverdue = (r, today) => isOpenStatus(r.status) && !!r.dueDate && r.dueDate < today;
export const completedOnTime = (r) => r.status === 'completed' && !!r.dueDate && !!r.closedAt && closedDay(r) <= r.dueDate;

/** The requests that count in the range (see the definition above): not cancelled, brand and department narrowed. */
export const requestsInScope = (requests, { from, to, brand, dept }) =>
  requests.filter((r) => {
    if (r.status === 'cancelled' || !brandOk(r, brand) || !deptOk(dept, r.fromDept, r.toDept)) return false;
    const made = createdDay(r);
    return inRange(made, from, to) || inRange(closedDay(r), from, to) || (isOpenStatus(r.status) && made < from);
  });

export const approvalClosedDay = (a) => (a.decidedAt ? istDay(a.decidedAt) : null);
export const approvalsInScope = (approvals, { from, to, brand, dept }) =>
  approvals.filter((a) => {
    if (!brandOk(a, brand) || !deptOk(dept, a.category)) return false;
    const made = createdDay(a);
    return inRange(made, from, to) || inRange(approvalClosedDay(a), from, to) || (AWAITING_APPROVAL.includes(a.status) && made < from);
  });

/** The headline figures (see the definitions above). `requests` / `approvals` are the loaded records; scoping is done here. */
export const coordKpis = ({ requests = [], approvals = [], range, today, includeApprovals = true }) => {
  const reqs = requestsInScope(requests, range);
  const apps = includeApprovals ? approvalsInScope(approvals, range) : [];
  const awaiting = apps.filter((a) => AWAITING_APPROVAL.includes(a.status));
  const linked = new Set(awaiting.map((a) => idOf(a.requestId)).filter(Boolean));
  const doneReqs = reqs.filter((r) => r.status === 'completed');
  const decided = apps.filter((a) => a.status === 'approved' || a.status === 'rejected');
  const withDue = [...doneReqs.filter((r) => r.dueDate), ...decided.filter((a) => a.dueDate)];
  const onTime = doneReqs.filter(completedOnTime).length + decided.filter((a) => a.dueDate && approvalClosedDay(a) <= a.dueDate).length;
  return {
    total: reqs.length + apps.length,
    requests: reqs.length,
    approvals: apps.length,
    completed: doneReqs.length + apps.filter((a) => a.status === 'approved').length,
    inProgress: reqs.filter((r) => r.status === 'in_progress').length,
    pending: reqs.filter((r) => PENDING_STATUSES.includes(r.status)).length,
    pendingApprovals: awaiting.length + reqs.filter((r) => r.status === 'pending_approval' && !linked.has(idOf(r._id ?? r.id))).length,
    overdue: reqs.filter((r) => isOverdue(r, today)).length + awaiting.filter((a) => a.dueDate && a.dueDate < today).length,
    onTimeRate: pct(onTime, withDue.length),
    onTimeOf: withDue.length,
  };
};

/** Total and completed against the period before (null when there is nothing to compare with). */
export const kpiChange = (now, before) => ({ total: changePct(now.total, before.total), completed: changePct(now.completed, before.completed) });

/** The three tabs of the task table: mine (assigned to me), team (assigned to any marketing member), all. Counts are of the scoped list. */
export const tabFilter = (list, scope, ownId) => {
  if (scope === 'my') return ownId ? list.filter((r) => idOf(r.assigneeId) === ownId) : [];
  if (scope === 'team') return list.filter((r) => !!idOf(r.assigneeId));
  return list;
};
export const tabCounts = (list, ownId) => ({ my: tabFilter(list, 'my', ownId).length, team: tabFilter(list, 'team', ownId).length, all: list.length });

/** The status filter of the table: a status, or a group (pending, overdue), or all. */
export const statusFilter = (list, status, today) => {
  if (!status || status === 'all') return list;
  if (status === 'pending') return list.filter((r) => PENDING_STATUSES.includes(r.status));
  if (status === 'overdue') return list.filter((r) => isOverdue(r, today));
  return list.filter((r) => r.status === status);
};

/** Soonest due first (no due day last), open work before completed, then newest. */
export const sortRequests = (list) =>
  [...list].sort((a, b) => {
    const ao = a.status === 'completed' ? 1 : 0;
    const bo = b.status === 'completed' ? 1 : 0;
    if (ao !== bo) return ao - bo;
    if ((a.dueDate ?? '9999') !== (b.dueDate ?? '9999')) return (a.dueDate ?? '9999') < (b.dueDate ?? '9999') ? -1 : 1;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

/**
 * "Request by Department": the biggest five departments and "Others" for the rest. `by`: 'requesting' | 'receiving' | 'both'
 * (both counts a request under each of its two teams, once when they are the same). total = requests; pct = share of the mentions.
 */
export const departmentBreakdown = (requests, by = 'both', top = 5) => {
  const counts = new Map();
  for (const r of requests) {
    const teams = by === 'requesting' ? [r.fromDept] : by === 'receiving' ? [r.toDept] : [...new Set([r.fromDept, r.toDept])];
    for (const t of teams) if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || DEPARTMENTS.indexOf(a[0]) - DEPARTMENTS.indexOf(b[0]));
  const shown = ranked.filter(([k]) => k !== 'Others').slice(0, top);
  const rest = ranked.filter(([k]) => !shown.some(([s]) => s === k));
  const othersCount = rest.reduce((s, [, n]) => s + n, 0);
  const rows = [...shown, ...(othersCount ? [['Others', othersCount]] : [])];
  const mentions = rows.reduce((s, [, n]) => s + n, 0);
  return {
    by,
    total: requests.length,
    rows: rows.map(([label, count]) => ({ key: label, label, count, pct: mentions ? Math.round((count / mentions) * 100) : 0 })),
    others: rest.map(([k]) => k).sort(),
  };
};

// ── Inter-Department (handovers) ──────────────────────────────────────────────

export const HANDOVER_STAGES = [
  { key: 'requested', label: 'Requested', status: 'open' },
  { key: 'in_progress', label: 'In Progress', status: 'in_progress' },
  { key: 'in_review', label: 'In Review', status: 'in_review' },
  { key: 'completed', label: 'Completed', status: 'completed' },
];
/** The board column a status belongs to (null for cancelled). */
export const handoverStage = (status) => {
  if (status === 'open') return 'requested';
  if (status === 'in_progress' || status === 'waiting_input') return 'in_progress';
  if (status === 'in_review' || status === 'pending_approval') return 'in_review';
  if (status === 'completed') return 'completed';
  return null;
};
/** The status a card gets when it is moved to a column (null for an unknown column). */
export const statusForStage = (stage) => HANDOVER_STAGES.find((s) => s.key === stage)?.status ?? null;

export const handoverKpis = (handovers, today) => {
  const open = handovers.filter((r) => isOpenStatus(r.status));
  return {
    active: open.length,
    awaitingAction: handovers.filter((r) => r.status === 'open' || r.status === 'waiting_input').length,
    inReview: handovers.filter((r) => r.status === 'in_review' || r.status === 'pending_approval').length,
    overdue: handovers.filter((r) => isOverdue(r, today)).length,
    completed: handovers.filter((r) => r.status === 'completed').length,
  };
};

/** The board: one column per stage, soonest due first; completed ones newest first. */
export const handoverColumns = (handovers) =>
  HANDOVER_STAGES.map((st) => {
    const items = handovers.filter((r) => handoverStage(r.status) === st.key);
    items.sort(st.key === 'completed' ? (a, b) => new Date(b.closedAt ?? 0) - new Date(a.closedAt ?? 0) : (a, b) => ((a.dueDate ?? '9999') < (b.dueDate ?? '9999') ? -1 : (a.dueDate ?? '9999') > (b.dueDate ?? '9999') ? 1 : new Date(b.createdAt) - new Date(a.createdAt)));
    return { key: st.key, label: st.label, count: items.length, items };
  });

// ── Approvals ─────────────────────────────────────────────────────────────────

/** The status an approval moves to with a decision, or null when that is not allowed from where it is. */
export const approvalNext = (status, decision) => {
  const open = AWAITING_APPROVAL.includes(status);
  if (!open) return null; // approved and rejected are final
  if (decision === 'review') return status === 'pending' ? 'in_review' : null;
  if (decision === 'approve') return 'approved';
  if (decision === 'reject') return 'rejected';
  if (decision === 'escalate') return status === 'escalated' ? null : 'escalated';
  return null;
};

export const approvalTab = (status) => (status === 'pending' ? 'pending' : status === 'approved' ? 'approved' : status === 'rejected' ? 'rejected' : 'in_review');
export const approvalKpis = (approvals) => ({
  total: approvals.length,
  pending: approvals.filter((a) => a.status === 'pending').length,
  inReview: approvals.filter((a) => a.status === 'in_review').length,
  escalated: approvals.filter((a) => a.status === 'escalated').length,
  approved: approvals.filter((a) => a.status === 'approved').length,
  rejected: approvals.filter((a) => a.status === 'rejected').length,
  awaitingAmount: approvals.filter((a) => AWAITING_APPROVAL.includes(a.status)).reduce((s, a) => s + (Number(a.amount) || 0), 0),
});
export const approvalTabCounts = (approvals) => ({
  pending: approvals.filter((a) => approvalTab(a.status) === 'pending').length,
  in_review: approvals.filter((a) => approvalTab(a.status) === 'in_review').length,
  approved: approvals.filter((a) => a.status === 'approved').length,
  rejected: approvals.filter((a) => a.status === 'rejected').length,
});

/** Content waiting for review, from the real records: posts in review (Socials) and assets in review (Creative Portfolio), oldest first. */
export const reviewQueue = ({ content = [], assets = [], brand = 'all' }) => {
  const items = [
    ...content.filter((c) => c.status === 'in-review' && brandOk(c, brand)).map((c) => ({ type: 'content', id: idOf(c._id ?? c.id), title: c.title, brand: c.brand ?? 'main', label: c.platform ? `${c.platform}${c.contentType ? ` · ${c.contentType}` : ''}` : c.contentType ?? 'Post', thumbUrl: c.thumbUrl ?? '', day: c.scheduledDate ? istDay(c.scheduledDate) : null, link: '/marketing/socials?tab=publishing' })),
    ...assets.filter((a) => a.stage === 'in_review' && brandOk(a, brand)).map((a) => ({ type: 'asset', id: idOf(a._id ?? a.id), title: a.title, brand: a.brand ?? 'main', label: a.kind ?? 'Asset', thumbUrl: a.thumbUrl ?? '', day: a.createdAt ? istDay(a.createdAt) : null, link: '/marketing/portfolio?tab=gallery' })),
  ];
  return items.sort((a, b) => ((a.day ?? '9999') < (b.day ?? '9999') ? -1 : (a.day ?? '9999') > (b.day ?? '9999') ? 1 : 0));
};

// ── Meetings ──────────────────────────────────────────────────────────────────

/** Where a meeting stands: completed · cancelled · upcoming (not started) · live (happening now) · to_close (ended, not closed yet). */
export const meetingState = (m, now = new Date()) => {
  if (m.status === 'completed') return 'completed';
  if (m.status === 'cancelled') return 'cancelled';
  const t = new Date(now).getTime();
  if (t < new Date(m.startAt).getTime()) return 'upcoming';
  return t <= new Date(m.endAt).getTime() ? 'live' : 'to_close';
};

export const meetingsInRange = (meetings, { from, to, brand, dept }) =>
  meetings.filter((m) => m.status !== 'cancelled' && brandOk(m, brand) && (!dept || dept === 'all' || (m.departments ?? []).includes(dept)) && inRange(istDay(m.startAt), from, to));

export const meetingKpis = (meetings, range, { today, now = new Date() }) => {
  const list = meetingsInRange(meetings, range);
  const week = weekRange(today);
  return {
    total: list.length,
    thisWeek: meetingsInRange(meetings, { from: week.from, to: week.to, brand: range.brand, dept: range.dept }).length,
    completed: list.filter((m) => m.status === 'completed').length,
    upcoming: list.filter((m) => ['upcoming', 'live'].includes(meetingState(m, now))).length,
    toClose: list.filter((m) => meetingState(m, now) === 'to_close').length,
  };
};

/** An action item's done state: the follow-up's when it has become one (one record, one answer), else its own. */
export const actionItemDone = (item, followUpById) => {
  const f = item.followUpId ? followUpById.get(idOf(item.followUpId)) : null;
  return f ? f.status === 'done' : !!item.done;
};

// ── Follow-ups ────────────────────────────────────────────────────────────────

/** completed · overdue · due_today · upcoming. */
export const followUpState = (f, today) => (f.status === 'done' ? 'completed' : f.dueDate < today ? 'overdue' : f.dueDate === today ? 'due_today' : 'upcoming');

/** Due in the range, or still open and overdue from before it. */
export const followUpsInScope = (list, { from, to, brand, dept, ownerId }, today) =>
  list.filter((f) => {
    if (!brandOk(f, brand) || !deptOk(dept, f.department)) return false;
    if (ownerId && idOf(f.ownerId) !== ownerId) return false;
    return inRange(f.dueDate, from, to) || (f.status === 'open' && f.dueDate < from && f.dueDate < today);
  });

export const followUpKpis = (list, today) => {
  const by = (s) => list.filter((f) => followUpState(f, today) === s).length;
  return { total: list.length, dueToday: by('due_today'), upcoming: by('upcoming'), overdue: by('overdue'), completed: by('completed') };
};

/** Every open follow-up past its day, the longest overdue first, with how many days ago it was due. */
export const overdueFollowUps = (list, today) =>
  list
    .filter((f) => followUpState(f, today) === 'overdue')
    .map((f) => ({ ...f, daysAgo: daysBetween(f.dueDate, today) }))
    .sort((a, b) => b.daysAgo - a.daysAgo);

/** The month's calendar: for each day with a follow-up due, how many are open, done and overdue. */
export const calendarDays = (list, today) => {
  const by = new Map();
  for (const f of list) {
    const d = by.get(f.dueDate) ?? { day: f.dueDate, total: 0, open: 0, done: 0, overdue: 0 };
    d.total += 1;
    if (f.status === 'done') d.done += 1;
    else {
      d.open += 1;
      if (f.dueDate < today) d.overdue += 1;
    }
    by.set(f.dueDate, d);
  }
  return [...by.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
};

// ── Team tasks in the task table ─────────────────────────────────────────────

export const TASK_STATUS_AS_REQUEST = { not_started: 'open', in_progress: 'in_progress', pending: 'waiting_input', blocked: 'waiting_input', completed: 'completed' };
export const TEAM_TASK_STATUSES = ['not_started', 'in_progress', 'pending', 'blocked', 'completed'];

/** A Team Dashboard task read as a row of the Coordinations task table (see "Team tasks in the table" above). */
export const taskAsRequest = (t) => ({
  _id: t._id ?? t.id,
  kind: 'task',
  title: t.title,
  detail: t.description ?? '',
  fromDept: 'Marketing',
  toDept: 'Marketing',
  requestedById: null,
  requestedByName: '',
  assigneeId: t.assigneeId ?? null,
  assigneeName: '',
  priority: PRIORITIES.includes(t.priority) ? t.priority : 'medium',
  dueDate: t.dueDate ?? null,
  status: TASK_STATUS_AS_REQUEST[t.status] ?? 'open',
  taskStatus: t.status,
  progress: t.status === 'completed' ? 100 : Math.max(0, Math.min(100, Math.round(Number(t.progress) || 0))),
  brand: t.brand ?? 'main',
  createdAt: t.createdAt,
  closedAt: t.status === 'completed' ? t.completedAt ?? null : null,
  createdBy: t.createdBy ?? null,
});

// ── Escalation ────────────────────────────────────────────────────────────────

/**
 * "Escalated to …" for an approval: the people named first (with their title), then any group not named one by one.
 * `to` = [{ name, title }]. e.g. "Escalated to Anjali (CEO), Rafeeq (Executive Director) and 2 Marketing Managers".
 */
export const escalationLabel = (to = []) => {
  if (!to.length) return '';
  const leaders = to.filter((p) => p.title !== 'Marketing Manager').map((p) => (p.name ? `${p.name} (${p.title})` : p.title));
  const managers = to.filter((p) => p.title === 'Marketing Manager');
  const parts = [...leaders];
  if (managers.length && leaders.length) parts.push(plural(managers.length, 'Marketing Manager'));
  else parts.push(...managers.map((p) => (p.name ? `${p.name} (Marketing Manager)` : 'the Marketing Manager')));
  const text = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  return `Escalated to ${text}`;
};

// ── Follow-up reminders ──────────────────────────────────────────────────────

/**
 * Should this follow-up's reminder go out now, and which one? → 'due' (due today), 'overdue' (past its day, never reminded for it) or
 * null (reminder off, done, not due yet, or already reminded for this due day).
 */
export const followUpReminderKind = (f, today) => {
  if (!f.reminder || f.status !== 'open' || !f.dueDate || f.dueDate > today) return null;
  if (f.remindedFor === f.dueDate) return null;
  return f.dueDate === today ? 'due' : 'overdue';
};

// ── Overview extras ───────────────────────────────────────────────────────────

/**
 * Upcoming Coordinations: meetings that have not ended and open requests' due days, from today to [until], soonest first
 * (a meeting at 11:00 before one due that day with no time). `period` is the dropdown the card shows.
 */
export const upcomingItems = ({ meetings = [], requests = [], now = new Date(), today, until, limit = 8 }) => {
  const items = [];
  for (const m of meetings) {
    if (!['upcoming', 'live'].includes(meetingState(m, now))) continue;
    const day = istDay(m.startAt);
    if (day < today || day > until) continue;
    items.push({ type: 'meeting', id: idOf(m._id ?? m.id), title: m.title, day, time: istTime(m.startAt), endTime: istTime(m.endAt), subtitle: (m.departments ?? []).join(', '), location: m.location ?? '' });
  }
  for (const r of requests) {
    if (!isOpenStatus(r.status) || !r.dueDate || r.dueDate < today || r.dueDate > until) continue;
    items.push({ type: 'request', id: idOf(r._id ?? r.id), title: r.title, day: r.dueDate, time: '', endTime: '', subtitle: `${r.fromDept} → ${r.toDept}`, location: '' });
  }
  return items.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.time === b.time ? 0 : a.time === '' ? 1 : b.time === '' ? -1 : a.time < b.time ? -1 : 1)).slice(0, limit);
};

/**
 * "Key Updates": plain sentences, each only when the data supports it. tone: good · info · warn · bad.
 * `awaiting` = approvals awaiting a decision (createdAt); `nextMeeting` = { title, day, time } or null.
 */
export const keyUpdates = ({ kpis, awaiting = [], nextMeeting = null, overdueFollowUps: lateFollowUps = 0, today }) => {
  const out = [];
  if (kpis.total > 0) out.push({ tone: kpis.completed / kpis.total >= 0.8 ? 'good' : 'info', text: `${kpis.completed} of ${kpis.total} ${kpis.total === 1 ? 'item' : 'items'} completed (${Math.round((kpis.completed / kpis.total) * 100)}%).` });
  else out.push({ tone: 'info', text: 'Nothing has been logged for this period yet.' });
  if (kpis.overdue > 0) out.push({ tone: 'bad', text: `${plural(kpis.overdue, 'item')} overdue.` });
  else if (kpis.total > 0) out.push({ tone: 'good', text: 'Nothing is overdue.' });
  const waiting = awaiting.length;
  if (waiting === 0) out.push({ tone: 'good', text: 'No approvals are waiting for a decision.' });
  else {
    const oldest = Math.max(...awaiting.map((a) => daysBetween(createdDay(a), today)));
    out.push(oldest > 2 ? { tone: 'warn', text: `${plural(waiting, 'approval')} waiting for a decision, the oldest for ${plural(oldest, 'day')}.` } : { tone: 'info', text: `${plural(waiting, 'approval')} waiting for a decision.` });
  }
  const escalated = awaiting.filter((a) => a.status === 'escalated').length;
  if (escalated > 0) out.push({ tone: 'warn', text: `${plural(escalated, 'escalated approval')} need${escalated === 1 ? 's' : ''} attention.` });
  if (nextMeeting) out.push({ tone: 'info', text: `Next meeting: ${nextMeeting.title}, ${nextMeeting.day === today ? 'today' : nextMeeting.day} at ${nextMeeting.time}.` });
  if (lateFollowUps > 0) out.push({ tone: 'bad', text: `${plural(lateFollowUps, 'follow-up')} overdue.` });
  return out.slice(0, 6);
};

export { istDay, addDays, daysBetween };
