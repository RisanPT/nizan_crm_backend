import { istDay, addDays, eachDay, previousRange, changePct } from './marketingTeamStats.js';
import * as S from './marketingSocialsStats.js';
import * as P from './marketingPortfolioStats.js';

// The Creative Director dashboard (GET /api/creative/overview) — every number is counted here, from records the Marketing module already
// keeps; nothing is typed for this screen. Days are IST 'YYYY-MM-DD'. What each number means:
//
//  • Active projects = shoots that are open (Planned → Post-production) — a shoot is the creative team's project. Each day of the
//    sparkline counts the shoots that were open that day (added on or before it, not yet delivered — the Distribution milestone ticked
//    — and not cancelled). "vs last period" compares today's count with the count on the last day of the period before.
//  • Concepts in progress = posts at Idea or Planned, counted on their planned day inside the range (as the Socials pipeline counts).
//  • Content approved = gallery assets approved (or made a final output) inside the range, on the day that was recorded.
//  • Content published, reach and engagement rate = the posts that went out inside the range, on the day they went out (Socials rules:
//    engagements = likes + comments + reposts + shares + saves; rate = engagements ÷ reach).
//  • The workflow is where the work stands, stage by stage; the approvals are everything waiting for a decision now, whatever its date.

export const WORKFLOW = [
  { key: 'brief', label: 'Creative Brief', points: ['Understand the brief', 'Brand goals', 'Target audience', 'Key message'] },
  { key: 'research', label: 'Research & Insight', points: ['Market research', 'Competitor study', 'Trend analysis', 'Audience insight'] },
  { key: 'concept', label: 'Concept & Ideation', points: ['Brainstorm ideas', 'Moodboard', 'Concept direction', 'Creative angles'] },
  { key: 'planning', label: 'Creative Planning', points: ['Content strategy', 'Visual style', 'Tone & voice', 'Shot list'] },
  { key: 'pre_production', label: 'Pre-Production', points: ['Location scouting', 'Talent planning', 'Props & setup', 'Schedule plan'] },
  { key: 'production', label: 'Production', points: ['Shoot execution', 'Direction', 'On-set review', 'Quality check'] },
  { key: 'post_production', label: 'Post-Production', points: ['Editing', 'Color grading', 'VFX / Graphics', 'Sound design'] },
  { key: 'review', label: 'Review & Approval', points: ['Internal review', 'Client feedback', 'Revisions', 'Final approval'] },
  { key: 'publish', label: 'Publish & Distribute', points: ['Platform selection', 'Scheduling', 'Publishing', 'QA check'] },
  { key: 'performance', label: 'Performance Tracking', points: ['Reach', 'Engagement', 'Views', 'Saves & shares'] },
  { key: 'strategy', label: 'Strategy Improvement', points: ['Analyse results', 'Learnings', 'Creative optimisation', 'Next steps'] },
];
// stages that count what happened in the range, not what is waiting now
const PERIOD_STAGES = new Set(['research', 'publish', 'performance', 'strategy']);

export const OPEN_SHOOT = new Set(['planned', 'pre_production', 'in_production', 'post_production']);
const IST = 5.5 * 60 * 60 * 1000;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const idOf = (v) => (v == null ? '' : String(v._id ?? v));
const brandOk = (x, brand) => !brand || brand === 'all' || (x.brand ?? 'main') === brand;
const round1 = (n) => Math.round(n * 10) / 10;

/** When a shoot was delivered: its Distribution milestone's tick (null while open). */
export const deliveredOn = (shoot) => {
  const m = (shoot.milestones ?? []).find((x) => x.key === 'distribution' && x.doneAt);
  return m ? istDay(m.doneAt) : null;
};

/** Was [shoot] open on [day]? Added by then, not delivered by then, not cancelled. */
export const openOn = (shoot, day) => {
  if (shoot.status === 'cancelled') return false;
  if (istDay(shoot.createdAt ?? 0) > day) return false;
  const done = deliveredOn(shoot);
  if (done) return done > day;
  return shoot.status !== 'completed'; // completed before the tick was recorded: no longer open
};

const flowKpi = (now, before, spark) => ({ value: now, change: changePct(now, before), spark });

/** The six KPI cards. */
export const kpis = ({ shoots, items, assets }, range) => {
  const prev = previousRange(range);
  const days = eachDay(range.from, range.to);
  const today = range.today ?? istDay();
  const myShoots = shoots.filter((s) => brandOk(s, range.brand));
  const lastDay = today < range.to ? today : range.to; // a range reaching into the future counts up to today
  const openCount = (day) => myShoots.filter((s) => openOn(s, day)).length;
  const activeProjects = {
    value: openCount(lastDay),
    change: changePct(openCount(lastDay), openCount(prev.to)),
    spark: days.map((d) => (d <= today ? openCount(d) : null)).filter((v) => v !== null),
  };

  const concepts = (r) => S.itemsInRange(items, { ...r, brand: range.brand }).filter((it) => ['idea', 'planned'].includes(it.status));
  const conceptsNow = concepts(range);
  const conceptsByDay = new Map();
  for (const it of conceptsNow) conceptsByDay.set(S.countedDay(it), (conceptsByDay.get(S.countedDay(it)) ?? 0) + 1);

  const approvedIn = (r) => assets.filter((a) => a.approvedAt && brandOk(a, range.brand) && istDay(a.approvedAt) >= r.from && istDay(a.approvedAt) <= r.to);
  const approvedNow = approvedIn(range);
  const approvedByDay = new Map();
  for (const a of approvedNow) approvedByDay.set(istDay(a.approvedAt), (approvedByDay.get(istDay(a.approvedAt)) ?? 0) + 1);

  const posted = S.postedItems(items, range);
  const postedBefore = S.postedItems(items, { ...prev, brand: range.brand });
  const byDay = new Map();
  for (const it of posted) {
    const d = S.countedDay(it);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(it);
  }
  const sumNow = S.sumMetrics(posted);
  const sumBefore = S.sumMetrics(postedBefore);
  const erNow = S.engagementRate(sumNow);
  const erBefore = S.engagementRate(sumBefore);

  return {
    activeProjects,
    concepts: flowKpi(conceptsNow.length, concepts(prev).length, days.map((d) => conceptsByDay.get(d) ?? 0)),
    approved: flowKpi(approvedNow.length, approvedIn(prev).length, days.map((d) => approvedByDay.get(d) ?? 0)),
    published: flowKpi(posted.length, postedBefore.length, days.map((d) => (byDay.get(d) ?? []).length)),
    reach: flowKpi(sumNow.reach, sumBefore.reach, days.map((d) => S.sumMetrics(byDay.get(d) ?? []).reach)),
    engagementRate: {
      value: erNow,
      before: erBefore,
      change: erNow != null && erBefore != null && erBefore > 0 ? Math.round(((erNow - erBefore) / erBefore) * 100) : null,
      spark: days.map((d) => S.engagementRate(S.sumMetrics(byDay.get(d) ?? [])) ?? 0),
    },
  };
};

/** The creative workflow: each stage's count now (or in the range, for the period stages) and what it is made of. */
export const workflow = ({ shoots, items, assets, findings = [], reviews = [], approvalsTotal = 0 }, range) => {
  const openShoots = shoots.filter((s) => brandOk(s, range.brand) && OPEN_SHOOT.has(s.status));
  const shootsAt = (status) => openShoots.filter((s) => s.status === status).length;
  const inRange = S.itemsInRange(items, range);
  const postsAt = (...statuses) => inRange.filter((it) => statuses.includes(it.status)).length;
  const myAssets = assets.filter((a) => brandOk(a, range.brand));
  const posted = S.postedItems(items, range);
  const withFigures = posted.filter((it) => S.engagementsOf(it.metrics ?? {}) > 0 || num(it.metrics?.reach) > 0 || num(it.metrics?.views) > 0).length;
  const myFindings = findings.filter((f) => brandOk(f, range.brand) && f.date >= range.from && f.date <= range.to);
  const myReviews = reviews.filter((r) => brandOk(r, range.brand) && r.reviewDate >= range.from && r.reviewDate <= range.to);
  const openActions = myReviews.reduce((n, r) => n + (r.actionItems ?? []).filter((a) => a.status !== 'done').length, 0);

  const parts = {
    brief: [{ label: 'shoots', count: shootsAt('planned') }],
    research: [{ label: 'findings', count: myFindings.length }],
    concept: [{ label: 'ideas', count: postsAt('idea') }],
    planning: [{ label: 'planned posts', count: postsAt('planned') }],
    pre_production: [{ label: 'shoots', count: shootsAt('pre_production') }],
    production: [
      { label: 'shoots', count: shootsAt('in_production') },
      { label: 'posts', count: postsAt('in-progress') },
    ],
    post_production: [
      { label: 'shoots', count: shootsAt('post_production') },
      { label: 'assets in edit', count: myAssets.filter((a) => ['in_edit', 'post_produced'].includes(a.stage)).length },
    ],
    review: [{ label: 'waiting', count: approvalsTotal }],
    publish: [
      { label: 'scheduled', count: postsAt('scheduled') },
      { label: 'published', count: posted.length },
    ],
    performance: [
      { label: 'with figures', count: withFigures },
      { label: 'missing figures', count: posted.length - withFigures },
    ],
    strategy: [
      { label: 'reviews', count: myReviews.length },
      { label: 'open actions', count: openActions },
    ],
  };
  return WORKFLOW.map((s) => {
    const p = parts[s.key].filter((x) => x.count > 0 || parts[s.key].length === 1);
    // performance: what is missing is the work left, so the stage counts the posts still to be measured
    const count = s.key === 'performance' ? posted.length - withFigures : parts[s.key].reduce((n, x) => n + x.count, 0);
    return { key: s.key, label: s.label, points: s.points, period: PERIOD_STAGES.has(s.key), count, parts: p };
  });
};

/** The open projects (shoots), soonest due first: the Distribution day, else the shoot day. */
export const activeProjects = (shoots, range, n = 6) => {
  const today = range.today ?? istDay();
  return shoots
    .filter((s) => brandOk(s, range.brand) && OPEN_SHOOT.has(s.status))
    .map((s) => {
      const due = (s.milestones ?? []).find((m) => m.key === 'distribution')?.date || s.shootDate || '';
      const stageKey = P.currentMilestone(s);
      const firstImage = (s.references ?? []).find((r) => r.kind === 'image' && r.url)?.url ?? '';
      return {
        id: idOf(s),
        title: s.title,
        brand: s.brand ?? 'main',
        category: s.category ?? '',
        status: s.status,
        statusLabel: P.STAGE_LABEL[s.status] ?? s.status,
        stage: (P.MILESTONES.find((m) => m.key === stageKey) ?? {}).label ?? '',
        progress: P.progressOf(s),
        shootDate: s.shootDate ?? '',
        dueDate: due,
        coverUrl: s.coverUrl || firstImage,
        delayed: P.isDelayed(s, today),
      };
    })
    .sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999') || a.title.localeCompare(b.title))
    .slice(0, n);
};

/** 'HH:MM' (IST) when a post has a time of day; '' for a post planned for the day only (midnight). */
export const timeOf = (date) => {
  if (!date) return '';
  const t = new Date(new Date(date).getTime() + IST).toISOString().slice(11, 16);
  return t === '00:00' ? '' : t;
};

/** Monday–Sunday of the week holding [day]. */
export const weekOf = (day) => {
  const dow = new Date(Date.parse(`${day}T00:00:00Z`)).getUTCDay();
  const monday = addDays(day, -((dow + 6) % 7));
  return { from: monday, to: addDays(monday, 6) };
};

/** The week's posts, day by day, in time order. */
export const calendarWeek = (items, week, brand) => {
  const inWeek = S.itemsInRange(items, { ...week, brand });
  return eachDay(week.from, week.to).map((day) => ({
    day,
    items: inWeek
      .filter((it) => S.countedDay(it) === day)
      .map((it) => ({
        id: idOf(it),
        title: it.title,
        platform: it.platform ?? 'other',
        contentType: it.contentType ?? 'other',
        status: it.status,
        time: timeOf(S.stageOf(it.status) === 'published' ? it.publishedDate ?? it.scheduledDate : it.scheduledDate),
      }))
      .sort((a, b) => (a.time || '99').localeCompare(b.time || '99') || a.title.localeCompare(b.title)),
  }));
};

/** Reach, engagements, views and saves over the posts that went out in the range — totals with the change, and day by day. */
export const performance = (items, range) => {
  const prev = previousRange(range);
  const now = S.sumMetrics(S.postedItems(items, range));
  const before = S.sumMetrics(S.postedItems(items, { ...prev, brand: range.brand }));
  const totals = { reach: now.reach, engagements: S.engagementsOf(now), views: now.views, saves: now.saves };
  const beforeTotals = { reach: before.reach, engagements: S.engagementsOf(before), views: before.views, saves: before.saves };
  const change = Object.fromEntries(Object.keys(totals).map((k) => [k, changePct(totals[k], beforeTotals[k])]));
  const byDay = new Map();
  for (const it of S.postedItems(items, range)) {
    const d = S.countedDay(it);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(it);
  }
  const trend = eachDay(range.from, range.to).map((day) => {
    const m = S.sumMetrics(byDay.get(day) ?? []);
    return { day, reach: m.reach, engagements: S.engagementsOf(m), views: m.views, saves: m.saves };
  });
  return { totals, change, trend };
};

/** The best posts of the range by reach (views when no reach was recorded), with each one's engagement rate. */
export const topContent = (items, range, n = 5) =>
  S.postedItems(items, range)
    .map((it) => {
      const m = it.metrics ?? {};
      return {
        id: idOf(it),
        title: it.title,
        platform: it.platform ?? 'other',
        contentType: it.contentType ?? 'other',
        thumbUrl: it.thumbUrl ?? '',
        permalink: it.permalink ?? '',
        reach: num(m.reach) || num(m.views),
        engagements: S.engagementsOf(m),
        er: S.engagementRate(m),
      };
    })
    .filter((r) => r.reach > 0 || r.engagements > 0)
    .sort((a, b) => b.reach - a.reach || b.engagements - a.engagements)
    .slice(0, n);

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
/** Open tasks: overdue first, then the soonest due, then the most urgent. */
export const openTasks = (tasks, names, range, n = 6) => {
  const today = range.today ?? istDay();
  const open = tasks.filter((t) => t.status !== 'completed' && brandOk(t, range.brand));
  const rows = open
    .map((t) => ({
      id: idOf(t),
      title: t.title,
      assignee: names.get(idOf(t.assigneeId)) ?? '',
      assigneeId: idOf(t.assigneeId),
      status: t.status,
      priority: t.priority ?? 'medium',
      dueDate: t.dueDate ?? '',
      overdue: !!t.dueDate && t.dueDate < today,
    }))
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.dueDate || '9999').localeCompare(b.dueDate || '9999') || (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1));
  return { total: rows.length, overdue: rows.filter((r) => r.overdue).length, items: rows.slice(0, n) };
};

/** Everything waiting for a creative decision: gallery assets in review and posts in review — oldest first. Waiting since = the last
 *  change to the record (the move into review is not recorded on its own). */
export const approvals = ({ assets, posts, shootTitles = new Map() }, range, n = 6) => {
  const now = range.nowMs ?? Date.now();
  const rows = [
    ...assets
      .filter((a) => a.stage === 'in_review' && brandOk(a, range.brand))
      .map((a) => ({ type: 'asset', id: idOf(a), title: a.title, sub: shootTitles.get(idOf(a.shootId)) ?? a.kind ?? '', thumbUrl: a.thumbUrl ?? '', since: a.updatedAt ?? a.createdAt })),
    ...posts
      .filter((p) => p.status === 'in-review' && brandOk(p, range.brand))
      .map((p) => ({ type: 'post', id: idOf(p), title: p.title, sub: `${S.PLATFORM_LABEL[p.platform] ?? 'Post'} · ${p.contentType ?? 'post'}`, thumbUrl: p.thumbUrl ?? '', since: p.updatedAt ?? p.createdAt })),
  ]
    .map((r) => ({ ...r, since: r.since ? new Date(r.since).toISOString() : null, waitingDays: r.since ? Math.max(0, Math.floor((now - new Date(r.since).getTime()) / 86_400_000)) : 0 }))
    .sort((a, b) => b.waitingDays - a.waitingDays || a.title.localeCompare(b.title));
  return { total: rows.length, assets: rows.filter((r) => r.type === 'asset').length, posts: rows.filter((r) => r.type === 'post').length, items: rows.slice(0, n) };
};

/** First and last day of the month holding [day]. */
export const monthOf = (day) => {
  const [y, m] = day.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${day.slice(0, 7)}-01`, to: `${day.slice(0, 7)}-${String(last).padStart(2, '0')}` };
};
const monthBefore = (day) => monthOf(addDays(monthOf(day).from, -1));

/** The month in three numbers: shoots delivered, posts published, and the average hours from adding an asset to approving it. */
export const monthOverview = ({ shoots, items, assets }, day, brand) => {
  const m = monthOf(day);
  const p = monthBefore(day);
  const delivered = (r) => shoots.filter((s) => brandOk(s, brand) && s.status !== 'cancelled' && (deliveredOn(s) ?? '') >= r.from && (deliveredOn(s) ?? '') <= r.to).length;
  const published = (r) => S.postedItems(items, { ...r, brand }).length;
  const avgHours = (r) => {
    const list = assets.filter((a) => a.approvedAt && a.createdAt && brandOk(a, brand) && istDay(a.approvedAt) >= r.from && istDay(a.approvedAt) <= r.to);
    if (!list.length) return null;
    const total = list.reduce((s, a) => s + Math.max(0, new Date(a.approvedAt) - new Date(a.createdAt)), 0);
    return round1(total / list.length / 3_600_000);
  };
  const hoursNow = avgHours(m);
  const hoursBefore = avgHours(p);
  return {
    month: m.from.slice(0, 7),
    projectsCompleted: { value: delivered(m), change: changePct(delivered(m), delivered(p)) },
    contentPublished: { value: published(m), change: changePct(published(m), published(p)) },
    avgApprovalHours: { value: hoursNow, change: hoursNow != null && hoursBefore ? Math.round(((hoursNow - hoursBefore) / hoursBefore) * 100) : null },
  };
};
