// Pure unit tests: node --test tests/marketingSocialsStats.test.js
// How the Socials screens count: posted items, the pipeline, engagement, performance, the tracker, growth, insights.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../utils/marketingSocialsStats.js';

const FROM = '2026-11-02';
const TO = '2026-11-08';
const R = { from: FROM, to: TO, brand: 'all' };
let n = 0;
const item = (extra = {}) => ({
  _id: `i${++n}`,
  title: `Post ${n}`,
  status: 'published',
  contentType: 'reel',
  platform: 'instagram',
  brand: 'main',
  scheduledDate: '2026-11-03T04:30:00Z',
  publishedDate: '2026-11-03T04:30:00Z',
  metrics: {},
  ...extra,
});

test('stages: ideas and planned are one stage; cancelled counts nowhere', () => {
  assert.equal(S.stageOf('idea'), 'planned');
  assert.equal(S.stageOf('planned'), 'planned');
  assert.equal(S.stageOf('in-progress'), 'producing');
  assert.equal(S.stageOf('in-review'), 'in_review');
  assert.equal(S.stageOf('scheduled'), 'scheduled');
  assert.equal(S.stageOf('published'), 'published');
  assert.equal(S.stageOf('cancelled'), null);
  assert.equal(S.stageOf('nonsense'), null);
});

test('formats: carousels and images are feed posts; trial reels and collabs are their own', () => {
  assert.equal(S.formatOf('reel'), 'reels');
  assert.equal(S.formatOf('trial_reel'), 'trialReels');
  assert.equal(S.formatOf('story'), 'stories');
  assert.equal(S.formatOf('post'), 'feed');
  assert.equal(S.formatOf('carousel'), 'feed');
  assert.equal(S.formatOf('image'), 'feed');
  assert.equal(S.formatOf('collab'), 'collab');
  assert.equal(S.formatOf('blog'), 'other');
});

test('posted: only published, on the day it went out, in the brand; the scheduled day is used when it was never marked out', () => {
  const items = [
    item(),
    item({ brand: 'kerala' }),
    item({ status: 'scheduled' }),
    item({ status: 'cancelled' }),
    item({ publishedDate: '2026-11-20T04:30:00Z', scheduledDate: '2026-11-04T04:30:00Z' }), // went out after the range
    item({ publishedDate: null, scheduledDate: '2026-11-05T04:30:00Z' }), // no posted date → scheduled day
  ];
  assert.equal(S.postedItems(items, R).length, 3);
  assert.equal(S.postedItems(items, { ...R, brand: 'kerala' }).length, 1);
  assert.equal(S.postedItems(items, { ...R, brand: 'main' }).length, 2);
});

test('the IST day decides the range edge (a post at 20:00 UTC on the 1st went out on the 2nd in India)', () => {
  const edge = item({ publishedDate: '2026-11-01T20:00:00Z', scheduledDate: '2026-11-01T20:00:00Z' });
  assert.equal(S.postedItems([edge], R).length, 1);
});

test('KPI strip: counts by format, with the change on the period before', () => {
  const items = [
    item(), item(), item({ contentType: 'trial_reel' }), item({ contentType: 'story' }), item({ contentType: 'carousel' }), item({ contentType: 'collab' }),
    // the week before: one reel
    item({ publishedDate: '2026-10-28T04:30:00Z', scheduledDate: '2026-10-28T04:30:00Z' }),
  ];
  const k = S.kpis(items, R);
  assert.equal(k.total, 6);
  assert.equal(k.reels, 2);
  assert.equal(k.trialReels, 1);
  assert.equal(k.stories, 1);
  assert.equal(k.feed, 1);
  assert.equal(k.collab, 1);
  assert.equal(k.change.reels, 100, '2 reels now vs 1 before');
  assert.equal(k.change.stories, null, 'no base to compare with');
});

test('pipeline: every non-cancelled item once, by stage, with its share', () => {
  const items = [
    item(), item(),
    item({ status: 'scheduled' }),
    item({ status: 'in-review' }),
    item({ status: 'in-progress' }),
    item({ status: 'idea' }),
    item({ status: 'cancelled' }),
  ];
  const p = S.pipeline(items, R);
  assert.equal(p.total, 6);
  const by = Object.fromEntries(p.stages.map((s) => [s.key, s]));
  assert.equal(by.published.count, 2);
  assert.equal(by.published.pct, 33);
  assert.equal(by.planned.count, 1);
  assert.equal(by.producing.count, 1);
  assert.equal(by.in_review.count, 1);
  assert.equal(by.scheduled.count, 1);
  assert.equal(S.pipeline([], R).total, 0);
  assert.ok(S.pipeline([], R).stages.every((s) => s.pct === 0));
});

test('platform distribution: Instagram splits by brand; a daily sparkline; change on the period before', () => {
  const items = [item(), item(), item({ brand: 'kerala' }), item({ platform: 'youtube' }), item({ publishedDate: '2026-10-28T04:30:00Z', scheduledDate: '2026-10-28T04:30:00Z' })];
  const d = S.platformDistribution(items, R);
  const main = d.find((r) => r.label === 'Instagram (Main)');
  assert.equal(main.count, 2);
  assert.equal(main.change, 100, '2 now vs 1 before');
  assert.equal(main.spark.length, 7);
  assert.equal(main.spark[1], 2, 'both went out on the 3rd');
  assert.ok(d.find((r) => r.label === 'Instagram (Kerala)'));
  assert.equal(d.find((r) => r.label === 'YouTube').count, 1);
  assert.equal(d[0].label, 'Instagram (Main)', 'biggest first');
});

test('engagement: the sum of what was typed on the posts that went out; the rate is over reach', () => {
  const items = [
    item({ metrics: { reach: 1000, likes: 80, comments: 10, reposts: 5, shares: 3, saves: 2, views: 1500, impressions: 1800 } }),
    item({ metrics: { reach: 1000, likes: 20 } }),
    item({ status: 'scheduled', metrics: { reach: 99999, likes: 99999 } }), // not out → not counted
  ];
  const e = S.engagementOverview(items, R);
  assert.equal(e.reach, 2000);
  assert.equal(e.likes, 100);
  assert.equal(e.engagements, 120);
  assert.equal(e.engagementRate, 6, '120 / 2000');
  assert.equal(S.engagementRate({ reach: 0, likes: 5 }), null, 'no reach → no rate');
});

test('reach trend: a point for every day, zero when nothing went out', () => {
  const t = S.reachTrend([item({ metrics: { reach: 500, impressions: 700 } })], R);
  assert.equal(t.length, 7);
  assert.equal(t[1].reach, 500);
  assert.equal(t[0].reach, 0);
});

test('top content: best first by views, reach when no views; posts with nothing typed are left out', () => {
  const items = [item({ title: 'A', metrics: { views: 100 } }), item({ title: 'B', metrics: { views: 900 } }), item({ title: 'C', metrics: { reach: 500 } }), item({ title: 'D' })];
  assert.deepEqual(S.topContent(items, R).map((r) => r.title), ['B', 'C', 'A']);
  assert.equal(S.topContent(items, R, 1).length, 1);
});

test('platform performance: posts, reach, impressions, engagements and rate per platform', () => {
  const items = [
    item({ metrics: { reach: 1000, impressions: 2000, likes: 100 } }),
    item({ platform: 'youtube', metrics: { reach: 400, impressions: 500, likes: 4 } }),
  ];
  const rows = S.platformPerformance(items, R);
  assert.equal(rows[0].label, 'Instagram');
  assert.equal(rows[0].er, 10);
  assert.equal(rows[1].er, 1);
  assert.equal(rows[1].posts, 1);
});

test('tracker: target against what was logged; no target → no progress', () => {
  const rows = S.trackerRows({
    metrics: [{ id: 'm1', name: 'Reels posted' }, { id: 'm2', name: 'Stories posted' }],
    targets: new Map([['m1', 26]]),
    logged: new Map([['m1', 27], ['m2', 14]]),
  });
  assert.deepEqual(rows[0], { metricId: 'm1', name: 'Reels posted', target: 26, completed: 27, progress: 104 });
  assert.equal(rows[1].target, null);
  assert.equal(rows[1].progress, null);
  assert.equal(rows[1].completed, 14);
});

test('monthly trend: the last N months ending at the given month, in order', () => {
  const items = [item({ metrics: { reach: 10 } }), item({ publishedDate: '2026-10-05T04:30:00Z', scheduledDate: '2026-10-05T04:30:00Z', metrics: { reach: 5 } })];
  const t = S.monthlyTrend(items, '2026-11-08', 3);
  assert.deepEqual(t.map((x) => x.month), ['2026-09', '2026-10', '2026-11']);
  assert.equal(t[2].reach, 10);
  assert.equal(t[1].reach, 5);
  assert.equal(t[0].posts, 0);
});

test('overall growth: the average change over reach, impressions and engagements that have a base', () => {
  assert.equal(S.overallGrowth({ reach: 120, impressions: 120, likes: 12 }, { reach: 100, impressions: 100, likes: 10 }), 20);
  assert.equal(S.overallGrowth({ reach: 10 }, { reach: 0, impressions: 0 }), null, 'nothing to compare with');
});

test('insights: only what the data supports', () => {
  assert.deepEqual(S.insights([], R, new Date('2026-11-05T00:00:00Z')), []);
  const items = [
    item({ contentType: 'reel', metrics: { reach: 100, likes: 40 } }),
    item({ contentType: 'reel', metrics: { reach: 100, likes: 60 } }),
    item({ contentType: 'post', metrics: { reach: 100, likes: 10 } }),
    item({ contentType: 'post', metrics: { reach: 100, likes: 10 } }),
  ];
  const lines = S.insights(items, R, new Date('2026-11-05T00:00:00Z'));
  assert.ok(lines.some((l) => l.startsWith('Reels earned 5×')), lines.join('|'));
  const late = S.insights([item({ status: 'planned', scheduledDate: '2026-11-01T04:30:00Z' })], R, new Date('2026-11-05T00:00:00Z'));
  assert.ok(late.some((l) => l.includes('1 item is past the scheduled day')));
});

test('organic Instagram leads: Instagram, not an ad; split Main / Kerala by region; the period before', () => {
  assert.equal(S.isOrganicInstagram('IG Leads — Main Page'), true, "the CRM's own source names");
  assert.equal(S.isOrganicInstagram('IG Leads — Kerala Page'), true);
  assert.equal(S.isOrganicInstagram('Instagram (Organic)'), true, 'legacy spelling');
  assert.equal(S.isOrganicInstagram('Instagram DM'), true);
  assert.equal(S.isOrganicInstagram('Paid Ads Leads'), false);
  assert.equal(S.isOrganicInstagram('Trial Campaign Leads'), false);
  assert.equal(S.isOrganicInstagram('Instagram (Paid)'), false);
  assert.equal(S.isOrganicInstagram('Instagram Ads'), false);
  assert.equal(S.isOrganicInstagram('WhatsApp (Organic)'), false);
  assert.equal(S.isOrganicInstagram(undefined), false);
  assert.equal(S.leadBrand({ source: 'IG Leads — Kerala Page', region: '' }), 'kerala', 'the page names the brand');
  assert.equal(S.leadBrand({ source: 'IG Leads — Main Page', region: 'Calicut' }), 'main', 'even in a Kerala region');
  assert.equal(S.leadBrand({ region: 'Calicut' }), 'kerala');
  assert.equal(S.leadBrand({ district: 'Ernakulam' }), 'kerala');
  assert.equal(S.leadBrand({ region: 'Bangalore' }), 'main');
  assert.equal(S.leadBrand({}), 'main');
  const leads = [
    { source: 'IG Leads — Kerala Page', region: '', day: '2026-11-03' },
    { source: 'IG Leads — Main Page', region: '', day: '2026-11-04' },
    { source: 'IG Leads — Main Page', region: 'Calicut', day: '2026-11-05' },
    { source: 'Paid Ads Leads', region: '', day: '2026-11-05' },
    { source: 'IG Leads — Main Page', region: '', day: '2026-10-28' },
    { source: 'IG Leads — Main Page', region: '', day: '2026-11-30' },
  ];
  const l = S.organicLeads(leads, R);
  assert.deepEqual({ total: l.total, main: l.main, kerala: l.kerala }, { total: 3, main: 2, kerala: 1 });
  assert.equal(l.change, 200, '3 now vs 1 before');
  assert.equal(S.organicLeads(leads, { ...R, brand: 'kerala' }).total, 1);
});

test('targets: the latest set for that week or earlier wins; brand beats all; all falls back to the brands added', () => {
  const rows = [
    { brand: 'all', period: '2026-10-26', metricId: 'm1', target: 20 },
    { brand: 'all', period: '2026-11-02', metricId: 'm1', target: 26 },
    { brand: 'kerala', period: '2026-11-02', metricId: 'm1', target: 5 },
    { brand: 'main', period: '2026-11-09', metricId: 'm2', target: 7 },
    { brand: 'kerala', period: '2026-11-09', metricId: 'm2', target: 2 },
  ];
  assert.equal(S.weekTarget(rows, { brand: 'all', week: '2026-11-02', metricId: 'm1' }), 26);
  assert.equal(S.weekTarget(rows, { brand: 'all', week: '2026-11-08', metricId: 'm1' }), 26, 'a week with none inherits the latest earlier');
  assert.equal(S.weekTarget(rows, { brand: 'all', week: '2026-10-26', metricId: 'm1' }), 20, 'the older target stayed');
  assert.equal(S.weekTarget(rows, { brand: 'kerala', week: '2026-11-02', metricId: 'm1' }), 5, "the brand's own row");
  assert.equal(S.weekTarget(rows, { brand: 'main', week: '2026-11-02', metricId: 'm1' }), 26, 'main has none of its own → all');
  assert.equal(S.weekTarget(rows, { brand: 'all', week: '2026-11-09', metricId: 'm2' }), 9, 'all has none → the brands added');
  assert.equal(S.weekTarget(rows, { brand: 'all', week: '2026-10-26', metricId: 'm2' }), null, 'nothing set yet');
  assert.equal(S.rangeTarget(rows, { brand: 'all', from: '2026-11-02', to: '2026-11-08', metricId: 'm1' }), 26);
  assert.equal(S.rangeTarget(rows, { brand: 'all', from: '2026-11-02', to: '2026-11-15', metricId: 'm1' }), 52, 'two weeks');
  assert.equal(S.rangeTarget(rows, { brand: 'all', from: '2026-11-04', to: '2026-11-06', metricId: 'm1' }), 11.1, 'three days of a 26-a-week target (pro-rated)');
  assert.equal(S.rangeTarget(rows, { brand: 'all', from: '2026-11-02', to: '2026-11-08', metricId: 'zz' }), null);
});

test('KPI change for one brand is against THAT brand\'s previous period, not everyone\'s', () => {
  const lastWeek = (extra) => item({ publishedDate: '2026-10-28T04:30:00Z', scheduledDate: '2026-10-28T04:30:00Z', ...extra });
  const items = [
    item({ brand: 'kerala' }), item({ brand: 'kerala' }), // this week: 2 Kerala reels
    lastWeek({ brand: 'kerala' }), // last week: 1 Kerala reel…
    lastWeek({ brand: 'main' }), lastWeek({ brand: 'main' }), lastWeek({ brand: 'main' }), // …and 3 Main ones
  ];
  assert.equal(S.kpis(items, { ...R, brand: 'kerala' }).change.reels, 100, '2 vs 1 for Kerala');
  assert.equal(S.kpis(items, { ...R, brand: 'all' }).change.reels, -50, '2 vs 4 for everyone');
  assert.equal(S.engagementOverview(items.map((i, n) => ({ ...i, metrics: { likes: 10 } })), { ...R, brand: 'kerala' }).change.likes, 100, 'engagement too');
});
