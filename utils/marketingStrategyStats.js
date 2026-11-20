import { istDay, addDays, daysBetween } from './marketingTeamStats.js';
import { leadDay, leadBrand } from './marketingLeadStages.js';

// What the Strategies & Developments screens show — ONE definition of every number, used by the Overview, Strategic Plans, Development
// Projects, Roadmap, Initiatives, Research & Insights and Reviews so they agree. Pure: no database (tests/marketingStrategyStats.test.js);
// controllers/marketingStrategiesController.js loads the records and calls these. Days are IST day strings 'YYYY-MM-DD'.
//
// WORK = an initiative (StrategicInitiative) or a development project (DevProject). Their progress comes from the TASKS tied to them
// (MarketingTask.initiativeId / .devProjectId):
//   task progress    a completed task is 100, any other task is its own `progress` (0–100). Every status counts (a blocked task at 30 is 30).
//   work progress    the mean of its tasks' progress, rounded. NO task tied → the progress typed by the owner (labelled "set by owner");
//                    nothing typed either → the work has NO progress (source 'none') — it is shown as such, never as an invented 0 and
//                    left out of every average.
//   owner            the owner chosen on the record; none chosen → the person holding most of its tasks ('from tasks'); else nobody.
//   due day          the due day typed on the record (an initiative's dueDate, a project's endDate); none → the latest due day among its
//                    tasks; else none. Start = the typed start day, else the day the record was made.
//   hours logged     minutes of the logs (MarketingActivity.initiativeId) tied to an initiative — all time, from the Log Activity form.
//
// STATUS (what the screens show: On Track / In Progress / At Risk / On Hold / Completed), checked in this order:
//   1. cancelled      stored status cancelled — counts nowhere.
//   2. completed      stored status completed (the manager said so), OR it has tasks and every one is completed.
//   3. on_hold        stored status on_hold — set by hand, never worked out.
//   4. at_risk        overdue: its due day has passed and it is not completed.
//   5. in_progress    not enough to judge: no due day, or no progress at all (source 'none').
//   6. at_risk        behind the clock: the share of time elapsed between start and due, minus the progress, is MORE than AT_RISK_MARGIN
//                     points (15). Time elapsed = days since start ÷ days from start to due, held between 0 and 100%.
//   7. on_track       otherwise: progress is at or ahead of the elapsed share, or behind it by no more than the margin.
//   "Active" (Initiatives) / "In Progress" (Projects) = every open one: on_track + in_progress + at_risk (not completed, not on hold).
//
// A work item COUNTS IN A RANGE when its span overlaps it: span = [start, end] where end = its due day, else the day it was completed,
// else open. A plan counts in a range when its year falls between the range's years. A finding counts on its date, a review on its day.
// Brand: 'all' counts both; otherwise the record's brand. Cancelled work counts nowhere.
//
// PLANS: "Active Plans" = plans with status active or in_progress (the live ones — the Overview's "Active Strategies" is the same number).
//   The Strategic Focus Areas list / donut = the live plans per focus area (so its total is the Active Strategies number); the Plan
//   Progress donut = ALL plans in range by status. Key Strategic Goals = the goals of the live plans.
// STRATEGY PERFORMANCE = per focus area, the mean progress of the initiatives in range that HAVE a progress (source not 'none').
// ROADMAP: a quarter's name is the theme typed most often on its items (ties: the earliest item); its progress = ticked ÷ items.
//   Timeline bar = the work's start → end clipped to the year; work with no end day is listed apart, never drawn.
// REVIEW SCORE: counted from the outcomes — Achieved / Partially / Not achieved shares; Overall score = the Achieved share.
// NEW THIS WEEK: plans + projects + initiatives made during the Monday–Sunday week of today (not cancelled), whatever the range.
// STRATEGY WORK LOGGED: the Strategies log types (projects worked on, first drafts, meetings, final drafts, executions — seeded by
//   utils/seedMarketingMaster.js) counted from the logs tied to an initiative (MarketingActivity.initiativeId) or a development project
//   (.devProjectId) — all time for the record, in the range for the Overview card (strategyLogCounts).
// REVIEW LINK: a review may name the plan, development project or initiative it reviews; it then shows that record's CURRENT progress
//   and status (worked out by the same rules as everywhere else), never a copy.
// ENQUIRY TREND (the document's "Market Trend Index", built from what we can measure — our own enquiries, never a made-up market
//   figure): the leads that arrived so far this quarter against the leads of the same number of days at the start of the quarter before,
//   by the Lead Report's rules (a lead counts on the day it arrived — leadDay — and for its brand — leadBrand). Change in percent; no
//   leads in the earlier window → no change ("—"), never 0 (enquiryTrend).

const pad2 = (n) => String(n).padStart(2, '0');
/** The calendar quarter of a day: { year, q, from, to }. */
export const quarterOf = (day) => {
  const y = Number(day.slice(0, 4));
  const q = Math.floor((Number(day.slice(5, 7)) - 1) / 3) + 1;
  const from = `${y}-${pad2((q - 1) * 3 + 1)}-01`;
  const to = addDays(q === 4 ? `${y + 1}-01-01` : `${y}-${pad2(q * 3 + 1)}-01`, -1);
  return { year: y, q, from, to };
};

/**
 * Enquiry trend vs last quarter (see above). `today` is the IST day; `leads` any list of CRM leads (only the two windows are counted).
 * → { label, quarter, previousQuarter, elapsedDays, now: { from, to, leads }, before: { from, to, leads }, change }
 */
export const enquiryTrend = ({ leads = [], today, brand = 'all' }) => {
  const cur = quarterOf(today);
  const prevYear = cur.q === 1 ? cur.year - 1 : cur.year;
  const prev = quarterOf(`${prevYear}-${pad2(cur.q === 1 ? 10 : (cur.q - 2) * 3 + 1)}-01`);
  const elapsedDays = daysBetween(cur.from, today) + 1;
  const prevTo = addDays(prev.from, elapsedDays - 1) > prev.to ? prev.to : addDays(prev.from, elapsedDays - 1);
  const count = (from, to) => leads.filter((l) => {
    const d = leadDay(l);
    return d >= from && d <= to && (!brand || brand === 'all' || leadBrand(l) === brand);
  }).length;
  const now = count(cur.from, today);
  const before = count(prev.from, prevTo);
  return {
    label: 'Enquiry trend vs last quarter',
    quarter: `Q${cur.q} ${cur.year}`,
    previousQuarter: `Q${prev.q} ${prev.year}`,
    elapsedDays,
    now: { from: cur.from, to: today, leads: now },
    before: { from: prev.from, to: prevTo, leads: before },
    change: before > 0 ? Math.round(((now - before) / before) * 100) : null,
  };
};

/**
 * The Strategies log types counted per initiative / development project. `activities` are logs; `metricName(id)` names a Strategies log
 * type (undefined for any other count, which is left out). → Map<workId, { total, minutes, logs, counts: [{ metric, total }] }> with the
 * key `initiative:<id>` or `project:<id>`, and the same totals for everything under the key 'all'.
 */
export const strategyLogCounts = (activities = [], metricName = () => undefined) => {
  const out = new Map();
  const bump = (key, a, values) => {
    const row = out.get(key) ?? { total: 0, minutes: 0, logs: 0, by: new Map() };
    row.logs += 1;
    row.minutes += a.timeSpentMinutes || 0;
    for (const v of values) {
      row.total += v.value;
      row.by.set(v.metric, (row.by.get(v.metric) ?? 0) + v.value);
    }
    out.set(key, row);
  };
  for (const a of activities) {
    const values = (a.values ?? []).map((v) => ({ metric: metricName(idOf(v.metricId)), value: Number(v.value) || 0 })).filter((v) => v.metric && v.value > 0);
    const keys = [a.initiativeId ? `initiative:${idOf(a.initiativeId)}` : null, a.devProjectId ? `project:${idOf(a.devProjectId)}` : null].filter(Boolean);
    if (!values.length && !keys.length) continue;
    for (const k of keys) bump(k, a, values);
    if (values.length) bump('all', a, values);
  }
  const done = new Map();
  for (const [k, r] of out) done.set(k, { total: r.total, minutes: r.minutes, logs: r.logs, counts: [...r.by.entries()].map(([metric, total]) => ({ metric, total })) });
  return done;
};

export const AT_RISK_MARGIN = 15;
export const STATUS_LABEL = { on_track: 'On Track', in_progress: 'In Progress', at_risk: 'At Risk', on_hold: 'On Hold', completed: 'Completed', cancelled: 'Cancelled' };
export const OPEN_STATUSES = ['on_track', 'in_progress', 'at_risk'];
export const FINDING_LABEL = { report: 'Research report', market_insight: 'Market insight', competitor: 'Competitor analysis', opportunity: 'Opportunity' };
export const OTHERS = 'Others';

const idOf = (v) => (v == null ? '' : String(v._id ?? v));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : null);
const brandOk = (rec, brand) => !brand || brand === 'all' || (rec.brand ?? 'main') === brand;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayOr = (v) => (typeof v === 'string' && DAY_RE.test(v) ? v : null);
const dayOf = (v) => (v ? istDay(v) : null);

// ── progress from the work ───────────────────────────────────────────────────

/** One task's progress: completed = 100, otherwise its own 0–100. */
export const taskProgress = (task) => (task.status === 'completed' ? 100 : clamp(Math.round(num(task.progress) ?? 0), 0, 100));

/**
 * The progress of a piece of work: { pct, source: 'tasks' | 'owner' | 'none', taskCount, doneCount }.
 * `tasks` are the tasks tied to it; `manual` is the progress typed on the record (used only when there are no tasks).
 */
export const progressOf = (tasks = [], manual = null) => {
  if (tasks.length) {
    const sum = tasks.reduce((s, t) => s + taskProgress(t), 0);
    return { pct: Math.round(sum / tasks.length), source: 'tasks', taskCount: tasks.length, doneCount: tasks.filter((t) => t.status === 'completed').length };
  }
  const typed = num(manual);
  if (typed !== null) return { pct: clamp(Math.round(typed), 0, 100), source: 'owner', taskCount: 0, doneCount: 0 };
  return { pct: 0, source: 'none', taskCount: 0, doneCount: 0 };
};

/** The owner: the one chosen on the record, else whoever holds most of its tasks (ties → the lowest id), else nobody. */
export const resolveOwner = (ownerId, tasks = []) => {
  if (ownerId) return { id: idOf(ownerId), source: 'set' };
  const count = new Map();
  for (const t of tasks) {
    const a = idOf(t.assigneeId);
    if (a) count.set(a, (count.get(a) ?? 0) + 1);
  }
  const best = [...count.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0];
  return best ? { id: best[0], source: 'tasks' } : { id: null, source: 'none' };
};

/** The due day: the one typed on the record, else the latest due day among its tasks, else none. */
export const resolveDue = (typed, tasks = []) => {
  const own = dayOr(typed);
  if (own) return { due: own, source: 'set' };
  const days = tasks.map((t) => dayOr(t.dueDate)).filter(Boolean).sort();
  return days.length ? { due: days[days.length - 1], source: 'tasks' } : { due: null, source: 'none' };
};

// ── status: due date against progress ────────────────────────────────────────

/** The share (0–1) of the time between [start] and [due] that has gone by on [today]. */
export const elapsedShare = (start, due, today) => {
  const span = daysBetween(start, due);
  if (span <= 0) return today >= due ? 1 : 0;
  return clamp(daysBetween(start, today) / span, 0, 1);
};

/**
 * The status to show — see the order in the header. `stored` is the hand-set status of the record (cancelled / completed / on_hold /
 * anything open). `progress` is progressOf()'s result.
 */
export const statusOf = ({ stored, progress, start, due, today }) => {
  if (stored === 'cancelled') return 'cancelled';
  if (stored === 'completed') return 'completed';
  if (stored === 'on_hold') return 'on_hold';
  if (progress.taskCount > 0 && progress.doneCount === progress.taskCount) return 'completed';
  if (!due) return 'in_progress';
  if (due < today) return 'at_risk';
  if (progress.source === 'none') return 'in_progress';
  const behind = elapsedShare(start ?? due, due, today) * 100 - progress.pct;
  return behind > AT_RISK_MARGIN ? 'at_risk' : 'on_track';
};

// ── one piece of work, worked out ────────────────────────────────────────────

/** The fields an initiative and a project share, under one set of names. */
const normalize = (kind, d) =>
  kind === 'project'
    ? { kind, id: idOf(d), title: d.name ?? '', brand: d.brand ?? 'main', focusArea: '', category: d.category ?? '', stored: d.status ?? 'in_progress', typedStart: d.startDate, typedDue: d.endDate, ownerId: d.ownerId, manual: d.progress, planId: d.planId, impact: '' }
    : { kind: 'initiative', id: idOf(d), title: d.title ?? '', brand: d.brand ?? 'main', focusArea: d.focusArea ?? '', category: '', stored: d.status ?? 'active', typedStart: d.startDate, typedDue: d.dueDate, ownerId: d.ownerId, manual: d.progress, planId: d.planId, impact: d.impact ?? 'medium' };

/**
 * An initiative or a development project with everything worked out. `kind` = 'initiative' | 'project'; `doc` the record; `tasks` the
 * tasks tied to it; `minutes` the minutes logged against it (initiatives). Returns a plain object (ids as strings).
 */
export const enrichWork = (kind, doc, tasks = [], { today = istDay(), minutes = 0 } = {}) => {
  const w = normalize(kind, doc);
  const progress = progressOf(tasks, w.manual);
  const owner = resolveOwner(w.ownerId, tasks);
  const due = resolveDue(w.typedDue, tasks);
  const start = dayOr(w.typedStart) ?? dayOf(doc.createdAt) ?? today;
  const status = statusOf({ stored: w.stored, progress, start, due: due.due, today });
  // the day it was finished: when the manager marked it, else the day its last task was completed
  const lastTaskDone = tasks.map((t) => dayOf(t.completedAt)).filter(Boolean).sort().pop() ?? null;
  const closedDay = status === 'completed' ? dayOf(doc.completedAt) ?? lastTaskDone : null;
  return {
    kind: w.kind,
    id: w.id,
    title: w.title,
    brand: w.brand,
    focusArea: w.focusArea,
    category: w.category,
    impact: w.impact,
    planId: w.planId ? idOf(w.planId) : null,
    storedStatus: w.stored,
    status,
    ownerId: owner.id,
    ownerSource: owner.source,
    progress: progress.pct,
    progressSource: progress.source,
    taskCount: progress.taskCount,
    doneCount: progress.doneCount,
    start,
    due: due.due,
    dueSource: due.source,
    closedDay,
    minutes: Math.max(0, Math.round(num(minutes) ?? 0)),
    createdDay: dayOf(doc.createdAt),
  };
};

/** The span of a piece of work: start → its due day, else the day it was completed, else open (null). */
export const spanOf = (e) => ({ start: e.start, end: e.due ?? e.closedDay ?? null });

/** Does the work count in [from, to] and the brand? Cancelled work counts nowhere. */
export const workInRange = (e, { from, to, brand }) => {
  if (e.status === 'cancelled' || !brandOk(e, brand)) return false;
  const { start, end } = spanOf(e);
  return start <= to && (end === null || end >= from);
};

/** The KPI strip counts of a list of work already filtered to the range (cancelled excluded). */
export const workCounts = (list) => {
  const n = (s) => list.filter((e) => e.status === s).length;
  const open = list.filter((e) => OPEN_STATUSES.includes(e.status)).length;
  return { total: list.length, open, completed: n('completed'), onHold: n('on_hold'), onTrack: n('on_track'), atRisk: n('at_risk'), inProgress: n('in_progress') };
};

/** Order for the Overview: open work first, by due day (no due day last); then on hold; completed last. */
export const byDueOpenFirst = (a, b) => {
  const rank = (e) => (OPEN_STATUSES.includes(e.status) ? 0 : e.status === 'on_hold' ? 1 : 2);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if ((a.due ?? '9999') !== (b.due ?? '9999')) return (a.due ?? '9999') < (b.due ?? '9999') ? -1 : 1;
  return a.title.localeCompare(b.title);
};

/** Strategy Performance: per focus area, the mean progress of the initiatives that have one. [{ focusArea, progress|null, initiatives, measured }]. */
export const performanceByFocusArea = (initiatives) => {
  const by = new Map();
  for (const e of initiatives) {
    const k = e.focusArea || OTHERS;
    const row = by.get(k) ?? { focusArea: k, sum: 0, measured: 0, initiatives: 0 };
    row.initiatives += 1;
    if (e.progressSource !== 'none') {
      row.sum += e.progress;
      row.measured += 1;
    }
    by.set(k, row);
  }
  return [...by.values()]
    .map((r) => ({ focusArea: r.focusArea, progress: r.measured ? Math.round(r.sum / r.measured) : null, initiatives: r.initiatives, measured: r.measured }))
    .sort((a, b) => b.initiatives - a.initiatives || a.focusArea.localeCompare(b.focusArea));
};

// ── plans ────────────────────────────────────────────────────────────────────

export const PLAN_LABEL = { active: 'Active', in_progress: 'In Progress', on_hold: 'On Hold', completed: 'Completed' };
export const isLivePlan = (p) => p.status === 'active' || p.status === 'in_progress';

/** The plans that count in the range (their year falls between the range's years) and brand. */
export const plansInRange = (plans, { from, to, brand }) => {
  const y1 = Number(from.slice(0, 4));
  const y2 = Number(to.slice(0, 4));
  return plans.filter((p) => brandOk(p, brand) && p.year >= y1 && p.year <= y2);
};

export const planCounts = (plans) => ({
  total: plans.length,
  active: plans.filter(isLivePlan).length,
  inProgress: plans.filter((p) => p.status === 'in_progress').length,
  onHold: plans.filter((p) => p.status === 'on_hold').length,
  completed: plans.filter((p) => p.status === 'completed').length,
});

/** The Plan Progress donut: every plan by status (zero slices kept so the legend is steady). */
export const planStatusSlices = (plans) =>
  Object.keys(PLAN_LABEL).map((key) => {
    const count = plans.filter((p) => p.status === key).length;
    return { key, label: PLAN_LABEL[key], count, pct: pct(count, plans.length) ?? 0 };
  });

/** Strategic Focus Areas: the LIVE plans per focus area, biggest first. */
export const focusAreaBreakdown = (plans) => {
  const by = new Map();
  for (const p of plans.filter(isLivePlan)) by.set(p.focusArea || OTHERS, (by.get(p.focusArea || OTHERS) ?? 0) + 1);
  return [...by.entries()].map(([focusArea, count]) => ({ focusArea, count })).sort((a, b) => b.count - a.count || a.focusArea.localeCompare(b.focusArea));
};

/** Key Strategic Goals: the goals of the live plans, in the order of the plans. */
export const keyGoals = (plans, limit = 8) => {
  const out = [];
  for (const p of plans.filter(isLivePlan)) for (const goal of p.goals ?? []) if (String(goal ?? '').trim()) out.push({ text: String(goal).trim(), plan: p.title, focusArea: p.focusArea });
  return out.slice(0, limit);
};

// ── roadmap ──────────────────────────────────────────────────────────────────

/** The quarter's name: the theme typed most often on its items (ties → the earliest in the list); '' when none was typed. */
export const quarterTheme = (items) => {
  const count = new Map();
  for (const it of items) {
    const t = (it.theme ?? '').trim();
    if (t) count.set(t, (count.get(t) ?? 0) + 1);
  }
  let best = '';
  let bestN = 0;
  for (const [t, n] of count) if (n > bestN) [best, bestN] = [t, n];
  return best;
};

/** The four quarters of [year] with their items (list order kept), the quarter's theme and how many are ticked. */
export const roadmapQuarters = (items, year) =>
  [1, 2, 3, 4].map((q) => {
    const mine = items.filter((it) => it.year === year && it.quarter === q);
    const done = mine.filter((it) => it.done).length;
    return { quarter: q, label: `Q${q}`, months: ['Jan – Mar', 'Apr – Jun', 'Jul – Sep', 'Oct – Dec'][q - 1], theme: quarterTheme(mine), items: mine, done, total: mine.length, pct: pct(done, mine.length) };
  });

const dayOfYear = (day) => daysBetween(`${day.slice(0, 4)}-01-01`, day);
const daysInYear = (year) => (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 366 : 365);

/**
 * The bar of a piece of work on the year's timeline: its span clipped to [year], as fractions (0–1) of the year; null when it does not
 * touch the year or has no end day (those go in `undated`, never drawn).
 */
export const timelineBar = (e, year) => {
  const { start, end } = spanOf(e);
  if (!end) return null;
  const first = `${year}-01-01`;
  const last = `${year}-12-31`;
  if (start > last || end < first) return null;
  const s = start < first ? first : start;
  const t = end > last ? last : end;
  const total = daysInYear(year);
  const from = dayOfYear(s) / total;
  const to = (dayOfYear(t) + 1) / total;
  return { from: Math.round(from * 10000) / 10000, to: Math.round(to * 10000) / 10000, startsBefore: start < first, endsAfter: end > last };
};

// ── research ─────────────────────────────────────────────────────────────────

export const findingsInRange = (findings, { from, to, brand }) => findings.filter((f) => brandOk(f, brand) && f.date >= from && f.date <= to);

/** The KPI strip: findings by kind. */
export const researchCounts = (findings) => ({
  total: findings.length,
  report: findings.filter((f) => f.kind === 'report').length,
  marketInsight: findings.filter((f) => f.kind === 'market_insight').length,
  competitor: findings.filter((f) => f.kind === 'competitor').length,
  opportunity: findings.filter((f) => f.kind === 'opportunity').length,
});

// ── reviews ──────────────────────────────────────────────────────────────────

export const reviewsInRange = (reviews, { from, to, brand }) => reviews.filter((r) => brandOk(r, brand) && r.reviewDate >= from && r.reviewDate <= to);

/** Achieved / partial / missed counted from the outcomes; shares are whole percents of all outcomes (null when there are none). */
export const reviewScores = (outcomes = []) => {
  const achieved = outcomes.filter((o) => o.state === 'achieved').length;
  const partial = outcomes.filter((o) => o.state === 'partial').length;
  const missed = outcomes.filter((o) => o.state === 'missed').length;
  const total = achieved + partial + missed;
  return { total, achieved, partial, missed, achievedPct: pct(achieved, total), partialPct: pct(partial, total), missedPct: pct(missed, total), overall: pct(achieved, total) };
};

/** The latest review (by its day, then when it was made) that was held on or before [day]. */
export const latestReview = (reviews, day) =>
  reviews
    .filter((r) => r.reviewDate <= day)
    .sort((a, b) => (a.reviewDate === b.reviewDate ? new Date(b.createdAt ?? 0) - new Date(a.createdAt ?? 0) : a.reviewDate < b.reviewDate ? 1 : -1))[0] ?? null;

// ── week, new this week, recent updates ──────────────────────────────────────

/** Monday–Sunday of the week of [day]. */
export const weekOf = (day) => {
  const dow = new Date(Date.parse(`${day}T00:00:00Z`)).getUTCDay();
  const monday = addDays(day, -((dow + 6) % 7));
  return { from: monday, to: addDays(monday, 6) };
};

/** Records (plans, work) made during the week, not cancelled, in the brand. */
export const newThisWeek = (records, { weekFrom, weekTo, brand }) =>
  records.filter((r) => r.status !== 'cancelled' && brandOk(r, brand) && r.createdAt && istDay(r.createdAt) >= weekFrom && istDay(r.createdAt) <= weekTo).length;

/**
 * Recent Updates — only real changes, newest first, inside the range:
 *   a task completed on an initiative / project · a roadmap line ticked · a review added · a finding added · a plan, project or
 *   initiative made. `tasks` carry `workTitle`/`assignee`; `work` is [{ kind, title, createdAt }]; roadmap lines `doneByName`; reviews
 *   `createdByName`; findings `authorName`.
 */
export const recentUpdates = ({ tasks = [], roadmap = [], reviews = [], findings = [], plans = [], work = [] }, { from, to }, limit = 20) => {
  const ev = [];
  for (const t of tasks) if (t.completedAt) ev.push({ kind: 'task_done', at: t.completedAt, text: `${t.title} completed`, subtitle: t.workTitle, by: t.assignee ?? '', refId: idOf(t) });
  for (const r of roadmap) if (r.done && r.doneAt) ev.push({ kind: 'roadmap_done', at: r.doneAt, text: `${r.title} ticked off`, subtitle: `Q${r.quarter} ${r.year} roadmap`, by: r.doneByName ?? '', refId: idOf(r) });
  for (const r of reviews) if (r.createdAt) ev.push({ kind: 'review', at: r.createdAt, text: `${r.periodLabel} review added`, subtitle: `${r.type[0].toUpperCase()}${r.type.slice(1)} review`, by: r.createdByName ?? '', refId: idOf(r) });
  for (const f of findings) if (f.createdAt) ev.push({ kind: 'finding', at: f.createdAt, text: `${f.title}`, subtitle: `${FINDING_LABEL[f.kind] ?? 'Finding'} added`, by: f.authorName ?? '', refId: idOf(f) });
  for (const p of plans) if (p.createdAt) ev.push({ kind: 'plan', at: p.createdAt, text: `${p.title} plan made`, subtitle: p.focusArea, by: '', refId: idOf(p) });
  for (const w of work) if (w.createdAt) ev.push({ kind: w.kind === 'project' ? 'project' : 'initiative', at: w.createdAt, text: `${w.title} ${w.kind === 'project' ? 'project' : 'initiative'} made`, subtitle: '', by: '', refId: idOf(w) });
  return ev
    .filter((e) => istDay(e.at) >= from && istDay(e.at) <= to)
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, limit)
    .map((e) => ({ ...e, at: new Date(e.at).toISOString() }));
};

/** Minutes → "12h 30m" style hours for the detail line. */
export const hoursLabel = (minutes) => {
  const m = Math.max(0, Math.round(minutes ?? 0));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
};
