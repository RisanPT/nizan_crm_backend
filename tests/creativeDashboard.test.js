import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../utils/creativeDashboard.js';
import { mayMarkCreativeDirector } from '../utils/userAccess.js';

// The Creative Director dashboard's numbers (utils/creativeDashboard.js). Week of Mon 2026-11-23 → Sun 2026-11-29; "today" is Wed 25th.
const range = { from: '2026-11-23', to: '2026-11-29', brand: 'all', today: '2026-11-25', nowMs: Date.parse('2026-11-25T06:30:00Z') };
const at = (day, hhmm = '00:00') => new Date(Date.parse(`${day}T${hhmm}:00Z`) - 5.5 * 3600 * 1000); // an IST wall time
const post = (o) => ({ _id: o.id ?? Math.random().toString(16).slice(2), title: o.title ?? 'Post', platform: 'instagram', contentType: 'reel', brand: 'main', metrics: {}, ...o });
const shoot = (o) => ({ _id: o.id ?? Math.random().toString(16).slice(2), title: o.title ?? 'Shoot', brand: 'main', status: 'planned', milestones: [], createdAt: at('2026-11-01'), ...o });

test('management only may make someone the Creative Director', () => {
  assert.equal(mayMarkCreativeDirector({ role: 'admin' }), true);
  assert.equal(mayMarkCreativeDirector({ role: 'manager' }), true);
  for (const role of ['hr', 'marketing_admin', 'sales_manager', 'fleet_manager', 'artist', 'ceo']) assert.equal(mayMarkCreativeDirector({ role }), false, role);
  assert.equal(mayMarkCreativeDirector({ role: 'artist', isDepartmentHead: true }), false, 'a department head');
});

test('a shoot is open from the day it is added until its Distribution milestone is ticked', () => {
  const s = shoot({ createdAt: at('2026-11-20'), status: 'completed', milestones: [{ key: 'distribution', doneAt: at('2026-11-24', '15:00') }] });
  assert.equal(C.openOn(s, '2026-11-19'), false, 'not yet added');
  assert.equal(C.openOn(s, '2026-11-23'), true);
  assert.equal(C.openOn(s, '2026-11-24'), false, 'delivered that day');
  assert.equal(C.openOn(shoot({ status: 'cancelled' }), '2026-11-25'), false);
  assert.equal(C.openOn(shoot({ status: 'completed' }), '2026-11-25'), false, 'completed before ticks were recorded');
  assert.equal(C.deliveredOn(s), '2026-11-24');
});

test('KPIs: active projects, concepts, approved, published, reach and engagement rate — each against the week before', () => {
  const shoots = [
    shoot({ status: 'in_production' }),
    shoot({ status: 'planned', createdAt: at('2026-11-24') }), // added Tuesday
    shoot({ status: 'completed', milestones: [{ key: 'distribution', doneAt: at('2026-11-18') }] }), // done last week
    shoot({ status: 'cancelled' }),
    shoot({ status: 'planned', brand: 'kerala' }),
  ];
  const items = [
    post({ status: 'idea', scheduledDate: at('2026-11-26') }),
    post({ status: 'planned', scheduledDate: at('2026-11-27') }),
    post({ status: 'planned', scheduledDate: at('2026-11-18') }), // last week
    post({ status: 'published', scheduledDate: at('2026-11-23'), publishedDate: at('2026-11-24', '18:00'), metrics: { reach: 1000, likes: 50, comments: 10, saves: 40 } }),
    post({ status: 'published', scheduledDate: at('2026-11-25'), metrics: { reach: 3000, likes: 120, shares: 30 } }),
    post({ status: 'published', scheduledDate: at('2026-11-17'), metrics: { reach: 2000, likes: 40 } }), // last week
    post({ status: 'cancelled', scheduledDate: at('2026-11-25'), metrics: { reach: 99999 } }),
  ];
  const assets = [
    { _id: 'a1', brand: 'main', approvedAt: at('2026-11-24', '10:00') },
    { _id: 'a2', brand: 'main', approvedAt: at('2026-11-25', '10:00') },
    { _id: 'a3', brand: 'main', approvedAt: at('2026-11-20', '10:00') }, // last week
  ];
  const k = C.kpis({ shoots, items, assets }, range);
  assert.equal(k.activeProjects.value, 3, 'in production + added Tuesday + the Kerala one');
  assert.deepEqual(k.activeProjects.spark, [2, 3, 3], 'Mon, Tue, Wed — no days after today');
  assert.equal(k.activeProjects.change, 50, '3 now against 2 on the last day of last week');
  assert.equal(k.concepts.value, 2);
  assert.equal(k.concepts.change, 100);
  assert.equal(k.approved.value, 2);
  assert.deepEqual(k.approved.spark, [0, 1, 1, 0, 0, 0, 0]);
  assert.equal(k.published.value, 2);
  assert.equal(k.published.change, 100);
  assert.equal(k.reach.value, 4000);
  assert.equal(k.reach.change, 100);
  assert.deepEqual(k.reach.spark, [0, 1000, 3000, 0, 0, 0, 0], 'reach on the day each post went out');
  // (50+10+40 + 120+30) ÷ 4000 = 6.25 → 6.3 ; last week 40 ÷ 2000 = 2
  assert.equal(k.engagementRate.value, 6.3);
  assert.equal(k.engagementRate.before, 2);
  assert.equal(k.engagementRate.change, 215);

  const kerala = C.kpis({ shoots, items, assets }, { ...range, brand: 'kerala' });
  assert.equal(kerala.activeProjects.value, 1, 'brand filter');
  assert.equal(kerala.published.value, 0);
  assert.equal(kerala.engagementRate.value, null, 'no reach → no rate (not 0)');
});

test('workflow: shoots by status, posts by stage in the range, the review queue, and the period stages', () => {
  const shoots = [shoot({ status: 'planned' }), shoot({ status: 'pre_production' }), shoot({ status: 'in_production' }), shoot({ status: 'post_production' }), shoot({ status: 'completed' })];
  const items = [
    post({ status: 'idea', scheduledDate: at('2026-11-26') }),
    post({ status: 'planned', scheduledDate: at('2026-11-26') }),
    post({ status: 'in-progress', scheduledDate: at('2026-11-26') }),
    post({ status: 'scheduled', scheduledDate: at('2026-11-28') }),
    post({ status: 'published', scheduledDate: at('2026-11-24'), metrics: { reach: 10 } }),
    post({ status: 'published', scheduledDate: at('2026-11-24') }), // no figures yet
    post({ status: 'idea', scheduledDate: at('2026-12-15') }), // outside the range
  ];
  const assets = [{ brand: 'main', stage: 'in_edit' }, { brand: 'main', stage: 'post_produced' }, { brand: 'main', stage: 'raw' }];
  const findings = [{ brand: 'main', date: '2026-11-24' }, { brand: 'main', date: '2026-10-01' }];
  const reviews = [{ brand: 'main', reviewDate: '2026-11-26', actionItems: [{ status: 'open' }, { status: 'done' }, { status: 'in_progress' }] }];
  const w = C.workflow({ shoots, items, assets, findings, reviews, approvalsTotal: 4 }, range);
  assert.deepEqual(w.map((s) => s.key), C.WORKFLOW.map((s) => s.key));
  assert.equal(w.length, 11);
  const by = Object.fromEntries(w.map((s) => [s.key, s]));
  assert.equal(by.brief.count, 1);
  assert.equal(by.research.count, 1);
  assert.equal(by.concept.count, 1);
  assert.equal(by.planning.count, 1);
  assert.equal(by.pre_production.count, 1);
  assert.equal(by.production.count, 2, 'a shoot in production and a post in production');
  assert.equal(by.post_production.count, 3, 'a shoot in post + two assets in edit');
  assert.equal(by.review.count, 4);
  assert.equal(by.publish.count, 3, '1 scheduled + 2 published');
  assert.equal(by.performance.count, 1, 'one post still has no figures');
  assert.equal(by.strategy.count, 3, '1 review + 2 open actions');
  assert.equal(by.research.period, true);
  assert.equal(by.brief.period, false);
  assert.equal(by.brief.points.length, 4);
});

test('active projects: open shoots, soonest due first, with stage, progress, cover and delay', () => {
  const list = C.activeProjects(
    [
      shoot({ id: 'late', title: 'Bridal Campaign', status: 'pre_production', shootDate: '2026-11-20', milestones: [{ key: 'brief', doneAt: at('2026-11-01') }, { key: 'pre_production', date: '2026-11-22' }, { key: 'distribution', date: '2026-11-30' }], references: [{ kind: 'link', url: 'https://x' }, { kind: 'image', url: 'https://img/1.jpg' }] }),
      shoot({ id: 'soon', title: 'Reel', status: 'planned', shootDate: '2026-11-27', coverUrl: 'https://cover.jpg' }),
      shoot({ id: 'done', status: 'completed' }),
    ],
    range,
  );
  assert.deepEqual(list.map((p) => p.id), ['soon', 'late'], 'due 27th (no distribution date → shoot day) before 30th');
  const late = list[1];
  assert.equal(late.stage, 'Pre-production');
  assert.equal(late.progress, 20);
  assert.equal(late.coverUrl, 'https://img/1.jpg', 'the first moodboard picture when there is no cover');
  assert.equal(late.delayed, true, 'pre-production was due on the 22nd');
  assert.equal(list[0].coverUrl, 'https://cover.jpg');
});

test('calendar week: Monday to Sunday, posts in time order, a midnight post has no time', () => {
  assert.deepEqual(C.weekOf('2026-11-25'), { from: '2026-11-23', to: '2026-11-29' });
  assert.deepEqual(C.weekOf('2026-11-29'), { from: '2026-11-23', to: '2026-11-29' }, 'Sunday belongs to the week before it');
  const days = C.calendarWeek(
    [
      post({ title: 'Evening', status: 'scheduled', scheduledDate: at('2026-11-25', '18:00') }),
      post({ title: 'Morning', status: 'planned', scheduledDate: at('2026-11-25', '10:00') }),
      post({ title: 'Any time', status: 'idea', scheduledDate: at('2026-11-25') }),
      post({ title: 'Out', status: 'published', scheduledDate: at('2026-11-20'), publishedDate: at('2026-11-26', '09:30') }),
      post({ title: 'Gone', status: 'cancelled', scheduledDate: at('2026-11-25', '11:00') }),
    ],
    { from: '2026-11-23', to: '2026-11-29' },
    'all',
  );
  assert.equal(days.length, 7);
  assert.deepEqual(days[2].items.map((i) => `${i.time}|${i.title}`), ['10:00|Morning', '18:00|Evening', '|Any time']);
  assert.deepEqual(days[3].items.map((i) => `${i.time}|${i.title}`), ['09:30|Out'], 'a published post sits on the day it went out');
});

test('performance, top content and the month card', () => {
  const items = [
    post({ title: 'A', status: 'published', scheduledDate: at('2026-11-24'), metrics: { reach: 1000, views: 1500, likes: 50, saves: 20 } }),
    post({ title: 'B', status: 'published', scheduledDate: at('2026-11-25'), metrics: { views: 4000, likes: 10 } }), // no reach typed
    post({ title: 'C', status: 'published', scheduledDate: at('2026-11-26'), metrics: {} }), // nothing yet
    post({ title: 'Old', status: 'published', scheduledDate: at('2026-10-30'), metrics: { reach: 5 } }),
  ];
  const p = C.performance(items, range);
  assert.deepEqual(p.totals, { reach: 1000, engagements: 80, views: 5500, saves: 20 });
  assert.equal(p.trend.length, 7);
  assert.equal(p.trend[1].reach, 1000);
  const top = C.topContent(items, range);
  assert.deepEqual(top.map((t) => t.title), ['B', 'A'], 'views stand in for reach; a post with no numbers is left out');
  assert.equal(top[1].er, 7, '(50+20) ÷ 1000');
  assert.equal(top[0].er, null, 'no reach → no rate');

  const month = C.monthOverview(
    {
      shoots: [shoot({ status: 'completed', milestones: [{ key: 'distribution', doneAt: at('2026-11-10') }] }), shoot({ status: 'completed', milestones: [{ key: 'distribution', doneAt: at('2026-10-10') }] })],
      items,
      assets: [
        { brand: 'main', createdAt: at('2026-11-10', '10:00'), approvedAt: at('2026-11-11', '10:00') }, // 24 h
        { brand: 'main', createdAt: at('2026-11-12', '10:00'), approvedAt: at('2026-11-12', '22:00') }, // 12 h
        { brand: 'main', createdAt: at('2026-10-01', '10:00'), approvedAt: at('2026-10-03', '10:00') }, // October: 48 h
      ],
    },
    '2026-11-25',
    'all',
  );
  assert.equal(month.month, '2026-11');
  assert.deepEqual(month.projectsCompleted, { value: 1, change: 0 });
  assert.deepEqual(month.contentPublished, { value: 3, change: 200 });
  assert.deepEqual(month.avgApprovalHours, { value: 18, change: -62 }, '18 h against 48 h: (18−48)÷48 = −62.5 %, rounded up');
  assert.deepEqual(C.monthOf('2026-02-10'), { from: '2026-02-01', to: '2026-02-28' });
});

test('open tasks (overdue first) and approvals (longest waiting first)', () => {
  const names = new Map([['m1', 'Fidha'], ['m2', 'Jibya']]);
  const t = C.openTasks(
    [
      { _id: 't1', title: 'Caption', assigneeId: 'm1', status: 'in_progress', priority: 'low', dueDate: '2026-11-28', brand: 'main' },
      { _id: 't2', title: 'Moodboard', assigneeId: 'm2', status: 'pending', priority: 'high', dueDate: '2026-11-20', brand: 'main' },
      { _id: 't3', title: 'Done', assigneeId: 'm1', status: 'completed', dueDate: '2026-11-20', brand: 'main' },
      { _id: 't4', title: 'Edit', assigneeId: 'm1', status: 'not_started', priority: 'high', dueDate: '2026-11-28', brand: 'main' },
    ],
    names,
    range,
  );
  assert.equal(t.total, 3);
  assert.equal(t.overdue, 1);
  assert.deepEqual(t.items.map((x) => x.title), ['Moodboard', 'Edit', 'Caption']);
  assert.equal(t.items[0].assignee, 'Jibya');

  const ap = C.approvals(
    {
      assets: [
        { _id: 'x1', title: 'Teaser', stage: 'in_review', brand: 'main', shootId: 's1', updatedAt: new Date(range.nowMs - 3 * 86_400_000) },
        { _id: 'x2', title: 'Still', stage: 'approved', brand: 'main', updatedAt: new Date(range.nowMs) },
      ],
      posts: [{ _id: 'p1', title: 'Reel', status: 'in-review', platform: 'instagram', contentType: 'reel', brand: 'main', updatedAt: new Date(range.nowMs - 3600_000) }],
      shootTitles: new Map([['s1', 'Brand Film']]),
    },
    range,
  );
  assert.equal(ap.total, 2);
  assert.deepEqual(ap.items.map((i) => `${i.type}:${i.title}:${i.waitingDays}`), ['asset:Teaser:3', 'post:Reel:0']);
  assert.equal(ap.items[0].sub, 'Brand Film');
});
