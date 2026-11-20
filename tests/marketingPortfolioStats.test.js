// Pure unit tests: node --test tests/marketingPortfolioStats.test.js
// How the Creative Portfolio counts: progress, delivered outputs, turnaround, load, availability, reports; and how logs move a shoot.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../utils/marketingPortfolioStats.js';
import { shootFromLogs } from '../services/marketingShootSync.js';
import { cleanShootInput, defaultMilestoneDates } from '../utils/marketingPortfolioInput.js';
import { addDays } from '../utils/marketingTeamStats.js';

const R = { from: '2026-11-01', to: '2026-11-30', brand: 'all' };
let n = 0;
const ms = (...done) => ['brief', 'pre_production', 'production', 'post_production', 'distribution'].map((key) => ({ key, date: null, doneAt: done.includes(key) ? new Date('2026-11-05T05:00:00Z') : null }));
const shoot = (extra = {}) => ({ _id: `s${++n}`, title: `Shoot ${n}`, brand: 'main', status: 'planned', shootDate: '2026-11-10', crew: [], planned: {}, milestones: ms('brief'), rescheduleCount: 0, ...extra });
const asset = (extra = {}) => ({ _id: `a${++n}`, shootId: 's0', kind: 'reel', stage: 'approved', isFinal: false, tags: [], sizeMb: 0, createdAt: '2026-11-12T05:00:00Z', ...extra });

test('progress: milestones done ÷ 5, and where the shoot is now', () => {
  assert.equal(P.progressOf(shoot({ milestones: ms('brief') })), 20);
  assert.equal(P.progressOf(shoot({ milestones: ms('brief', 'pre_production') })), 40);
  assert.equal(P.progressOf(shoot({ milestones: ms('brief', 'pre_production', 'production', 'post_production', 'distribution') })), 100);
  assert.equal(P.progressOf(shoot({ milestones: [] })), 0);
  assert.equal(P.currentMilestone(shoot({ milestones: ms('brief') })), 'pre_production');
  assert.equal(P.currentMilestone(shoot({ milestones: ms('brief', 'pre_production') })), 'production');
  assert.equal(P.currentMilestone(shoot({ milestones: ms('brief', 'pre_production', 'production', 'post_production', 'distribution') })), 'distribution', 'the last one when all are done');
});

test('outputs: what an asset meets; footage is not an output; only approved or final counts as delivered', () => {
  assert.equal(P.outputKeyOf({ kind: 'reel' }), 'reels');
  assert.equal(P.outputKeyOf({ kind: 'film' }), 'films');
  assert.equal(P.outputKeyOf({ kind: 'carousel' }), 'carousels');
  assert.equal(P.outputKeyOf({ kind: 'design' }), 'decks');
  assert.equal(P.outputKeyOf({ kind: 'document' }), 'decks');
  assert.equal(P.outputKeyOf({ kind: 'still', tags: [] }), 'stills');
  assert.equal(P.outputKeyOf({ kind: 'still', tags: ['story'] }), 'storyFrames');
  assert.equal(P.outputKeyOf({ kind: 'bts' }), null);
  assert.equal(P.outputKeyOf({ kind: 'other' }), null);
  assert.equal(P.isDelivered({ stage: 'approved' }), true);
  assert.equal(P.isDelivered({ stage: 'in_edit', isFinal: true }), true);
  assert.equal(P.isDelivered({ stage: 'in_review' }), false);
  const d = P.deliveredOf([asset(), asset({ kind: 'still' }), asset({ kind: 'still', tags: ['story'] }), asset({ kind: 'bts' }), asset({ stage: 'raw' }), asset({ stage: 'in_edit', isFinal: true, kind: 'film' })]);
  assert.deepEqual(d, { reels: 1, stills: 1, films: 1, carousels: 0, storyFrames: 1, decks: 0 });
  assert.equal(P.deliveredTotal([asset(), asset({ stage: 'raw' })]), 1);
});

test('turnaround: none until every planned output is delivered; then days to the last one', () => {
  const s = shoot({ planned: { reels: 2 } });
  assert.equal(P.turnaroundDays(s, []), null);
  assert.equal(P.turnaroundDays(s, [asset()]), null, '1 of 2 delivered');
  assert.equal(P.turnaroundDays(s, [asset({ createdAt: '2026-11-12T05:00:00Z' }), asset({ createdAt: '2026-11-14T05:00:00Z' })]), 4, '10th → 14th');
  assert.equal(P.turnaroundDays(shoot({ planned: {}, status: 'completed' }), [asset()]), 2, 'no plan, completed → the delivery that exists');
  assert.equal(P.turnaroundDays(shoot({ planned: {} }), [asset()]), null, 'no plan and not completed → unknown');
  assert.equal(P.turnaroundDays(shoot({ planned: { reels: 1 }, status: 'completed' }), [asset({ stage: 'raw' })]), null, 'nothing delivered');
  assert.equal(P.turnaroundDays(shoot({ planned: { reels: 1 }, shootDate: '2026-11-20' }), [asset({ createdAt: '2026-11-12T05:00:00Z' })]), 0, 'never negative');
});

test('counts: by status in the range and brand; cancelled counts nowhere; this week; rescheduled', () => {
  const shoots = [
    shoot(), shoot({ status: 'pre_production' }), shoot({ status: 'in_production' }), shoot({ status: 'post_production' }), shoot({ status: 'completed' }),
    shoot({ status: 'cancelled' }), shoot({ brand: 'kerala' }), shoot({ shootDate: '2026-12-05' }), shoot({ rescheduleCount: 2 }),
    shoot({ shootDate: '2026-11-11', status: 'in_production' }),
  ];
  const c = P.shootCounts(shoots, R, { today: '2026-11-10', weekFrom: '2026-11-09', weekTo: '2026-11-15' });
  assert.equal(c.total, 8, 'cancelled and the December one are out');
  assert.equal(c.planned, 4, 'planned + pre-production (incl. the Kerala and rescheduled)');
  assert.equal(c.inProduction, 2);
  assert.equal(c.postProduction, 1);
  assert.equal(c.completed, 1);
  assert.equal(c.rescheduled, 1);
  assert.equal(c.thisWeek, 8);
  assert.equal(c.today, 7, 'all but the one on the 11th');
  assert.equal(P.shootCounts(shoots, { ...R, brand: 'kerala' }).total, 1);
});

test('production load: planned and pre-production are one slice; shares of the whole', () => {
  const l = P.productionLoad([shoot(), shoot({ status: 'pre_production' }), shoot({ status: 'in_production' }), shoot({ status: 'completed' })], R);
  assert.equal(l.total, 4);
  assert.deepEqual(l.rows.map((r) => [r.key, r.count, r.pct]), [['pre_production', 2, 50], ['in_production', 1, 25], ['post_production', 0, 0], ['completed', 1, 25]]);
  assert.deepEqual(P.productionLoad([], R).rows.map((r) => r.pct), [0, 0, 0, 0]);
});

test('crew availability: per role, people on a shoot or on leave are not available', () => {
  const members = [
    { id: 'v1', role: 'Videographer' }, { id: 'v2', role: 'Videographer' }, { id: 'v3', role: 'Videographer', onLeave: true },
    { id: 'e1', role: 'Editor' }, { id: 'x1', role: '' },
  ];
  const day = [shoot({ crew: [{ memberId: 'v1' }, { memberId: 'e1' }] }), shoot({ status: 'cancelled', crew: [{ memberId: 'v2' }] })];
  const a = P.crewAvailability({ members, shootsOnDay: day });
  const v = a.find((r) => r.role === 'Videographer');
  assert.deepEqual(v, { role: 'Videographer', total: 3, booked: 1, onLeave: 1, absent: 0, onWork: 0, available: 1 }, 'a cancelled shoot books nobody');
  assert.deepEqual(a.find((r) => r.role === 'Editor'), { role: 'Editor', total: 1, booked: 1, onLeave: 0, absent: 0, onWork: 0, available: 0 });
  assert.ok(a.find((r) => r.role === 'Team member'), 'a member with no role is still counted');
  assert.equal(a[0].role, 'Videographer', 'biggest team first');
});

test('report row, KPIs with the change on the period before, monthly bars and the output split', () => {
  const s1 = shoot({ _id: 'A', status: 'completed', planned: { reels: 2, stills: 1 } });
  const s2 = shoot({ _id: 'B', shootDate: '2026-10-20', status: 'completed', planned: { reels: 1 } });
  const byShoot = P.assetsByShoot([
    asset({ shootId: 'A', createdAt: '2026-11-13T05:00:00Z', sizeMb: 2048 }), asset({ shootId: 'A', createdAt: '2026-11-14T05:00:00Z' }), asset({ shootId: 'A', kind: 'still', createdAt: '2026-11-14T05:00:00Z' }),
    asset({ shootId: 'B', createdAt: '2026-10-22T05:00:00Z' }),
  ]);
  const row = P.reportRow(s1, byShoot.get('A'));
  assert.equal(row.deliveredTotal, 3);
  assert.equal(row.plannedTotal, 3);
  assert.equal(row.onTrack, true);
  assert.equal(row.turnaround, 4);
  const k = P.reportKpis([s1, s2], byShoot, R);
  assert.deepEqual({ shoots: k.shoots, completed: k.completed, outputs: k.outputs, footageGb: k.footageGb, turnaround: k.turnaround }, { shoots: 1, completed: 1, outputs: 3, footageGb: 2, turnaround: 4 });
  const prev = P.reportKpis([s1, s2], byShoot, { from: '2026-10-01', to: '2026-10-31', brand: 'all' });
  assert.equal(prev.shoots, 1);
  assert.equal(prev.outputs, 1);
  assert.equal(prev.turnaround, 2);
  assert.equal(k.change.outputs, 200, '3 now vs 1 before');
  assert.equal(k.change.turnaround, 100, '4 vs 2 days');
  assert.equal(k.change.footageGb, null, 'no footage figure before');
  const months = P.monthlyReport([s1, s2], byShoot, '2026-11-30', 3);
  assert.deepEqual(months.map((m) => m.month), ['2026-09', '2026-10', '2026-11']);
  assert.deepEqual(months.map((m) => [m.planned, m.delivered]), [[0, 0], [1, 1], [3, 3]]);
  const d = P.outputDistribution([s1, s2], byShoot, R);
  assert.equal(d.total, 3);
  assert.deepEqual(d.rows.map((r) => [r.key, r.count, r.pct]), [['reels', 2, 67], ['stills', 1, 33]]);
  assert.equal(P.reportKpis([], new Map(), R).footageGb, null);
});

test('delayed: open, with a milestone date gone by and not done; completed and cancelled never are', () => {
  const late = shoot({ milestones: [{ key: 'brief', date: '2026-11-07', doneAt: new Date() }, { key: 'pre_production', date: '2026-11-08', doneAt: null }] });
  assert.equal(P.isDelayed(late, '2026-11-10'), true);
  assert.equal(P.isDelayed(late, '2026-11-08'), false, 'the day itself is not late');
  assert.equal(P.isDelayed({ ...late, status: 'completed' }, '2026-11-10'), false);
  assert.equal(P.isDelayed({ ...late, status: 'cancelled' }, '2026-11-10'), false);
  assert.equal(P.isDelayed(shoot({ milestones: ms('brief') }), '2026-11-10'), false, 'no dates set → not late');
});

test('takeaways: only what the shoot supports', () => {
  assert.deepEqual(P.takeaways(shoot(), []), []);
  const s = shoot({ planned: { reels: 2 } });
  assert.deepEqual(P.takeaways(s, [asset()]), ['1 of 2 planned outputs delivered so far.']);
  assert.ok(P.takeaways(s, [asset(), asset()]).includes('All planned outputs have been delivered.'));
  assert.ok(P.takeaways(shoot({ status: 'completed', planned: { reels: 3 } }), [asset()]).some((l) => l.includes('2 planned outputs not delivered')));
  assert.ok(P.takeaways(shoot(), [asset({ kind: 'bts', stage: 'raw' })]).some((l) => l.includes('Only raw footage')));
});

test('logs move a shoot: a completed stage log marks its milestone; any log moves the phase forward, never back', () => {
  const s = shoot({ status: 'planned', milestones: ms('brief'), createdAt: '2026-11-01T00:00:00Z' });
  const log = (stage, status, at) => ({ shootStage: stage, status, loggedAt: at });
  const none = shootFromLogs(s, []);
  assert.equal(none.status, 'planned');
  assert.equal(none.milestones.filter((m) => m.doneAt).length, 1, 'only the brief');

  const pre = shootFromLogs(s, [log('pre_production', 'in_progress', '2026-11-06T05:00:00Z')]);
  assert.equal(pre.status, 'pre_production');
  assert.equal(pre.milestones.find((m) => m.key === 'pre_production').doneAt, null, 'in progress is not done');

  const done = shootFromLogs(s, [log('pre_production', 'completed', '2026-11-06T05:00:00Z'), log('pre_production', 'completed', '2026-11-08T05:00:00Z'), log('production', 'in_progress', '2026-11-10T05:00:00Z')]);
  assert.equal(done.status, 'in_production');
  assert.equal(new Date(done.milestones.find((m) => m.key === 'pre_production').doneAt).toISOString(), '2026-11-08T05:00:00.000Z', 'the latest completed log');
  assert.equal(P.progressOf({ milestones: done.milestones }), 40);

  const post = shootFromLogs({ ...s, status: 'post_production' }, [log('pre_production', 'completed', '2026-11-06T05:00:00Z')]);
  assert.equal(post.status, 'post_production', 'a later status set by hand is never pulled back by an earlier-stage log');
  assert.equal(shootFromLogs({ ...s, status: 'cancelled' }, [log('production', 'completed', '2026-11-10T05:00:00Z')]).status, 'cancelled');
  assert.equal(shootFromLogs({ ...s, status: 'completed' }, []).milestones.find((m) => m.key === 'distribution').doneAt !== null, true, 'completed → distribution done');
  assert.equal(shootFromLogs(s, []).milestones.find((m) => m.key === 'distribution').doneAt, null);
  assert.equal(shootFromLogs(s, [log('production', 'completed', '2026-11-10T05:00:00Z')]).milestones.find((m) => m.key === 'brief').doneAt !== null, true);
});

test('shoot input: title, a real date, brand, times, planned outputs, crew and references are checked', () => {
  const ok = (b, e) => cleanShootInput(b, e);
  assert.equal(ok({ shootDate: '2026-11-10' }).field, 'title');
  assert.equal(ok({ title: 'x', shootDate: '2026-11-10' }).field, 'title');
  assert.equal(ok({ title: 'Bridal', shootDate: '2026-02-31' }).field, 'shootDate');
  assert.equal(ok({ title: 'Bridal' }).field, 'shootDate');
  assert.equal(ok({ title: 'Bridal', shootDate: '2026-11-10', brand: 'mars' }).field, 'brand');
  assert.equal(ok({ title: 'Bridal', shootDate: '2026-11-10', status: 'done' }).field, 'status');
  assert.equal(ok({ title: 'Bridal', shootDate: '2026-11-10', startTime: '9:30' }).field, 'startTime');
  assert.equal(ok({ title: 'Bridal', shootDate: '2026-11-10', startTime: '10:00', endTime: '09:00' }).field, 'endTime');
  assert.equal(ok({ title: 'Bridal', shootDate: '2026-11-10', planned: { reels: -1 } }).field, 'planned');
  assert.equal(ok({ title: 'Bridal', shootDate: '2026-11-10', planned: { reels: 1.5 } }).field, 'planned');
  assert.equal(ok({ title: 'Bridal', shootDate: '2026-11-10', coverUrl: 'javascript:x' }).field, 'coverUrl');
  assert.equal(ok({ title: 'Bridal', shootDate: '2026-11-10', references: ['nope'] }).field, 'references');
  assert.equal(ok({ title: 'Bridal', shootDate: '2026-11-10', milestones: [{ key: 'brief' }, { key: 'brief' }] }).field, 'milestones');
  assert.equal(ok({ title: 'Bridal', shootDate: '2026-11-10', milestones: [{ key: 'wat' }] }).field, 'milestones');
  const good = ok({ title: ' Bridal ', shootDate: '2026-11-10', startTime: '09:00', endTime: '17:00', planned: { reels: '3', stills: 10 }, crew: [{ name: ' Ashique ', role: 'Videographer' }, { name: '' }], references: [{ url: 'https://a.test/m', label: 'Moodboard' }], brand: 'kerala' });
  assert.equal(good.ok, true);
  assert.equal(good.value.title, 'Bridal');
  assert.deepEqual(good.value.planned, { reels: 3, stills: 10, films: 0, carousels: 0, storyFrames: 0, decks: 0 });
  assert.deepEqual(good.value.crew, [{ memberId: null, employeeId: null, name: 'Ashique', role: 'Videographer' }], 'an empty crew line is dropped');
  assert.equal(ok({ endTime: '08:00' }, { startTime: '09:00' }).field, 'endTime', 'an update is checked against the stored start');
  assert.deepEqual(ok({ status: 'completed' }, { title: 'x' }).value, { status: 'completed' }, 'an update changes only what was sent');
  assert.deepEqual(defaultMilestoneDates('2026-11-10', addDays), { brief: '2026-11-07', pre_production: '2026-11-08', production: '2026-11-10', post_production: '2026-11-12', distribution: '2026-11-14' });
});

test('the monthly bars follow the brand filter', () => {
  const main = shoot({ _id: 'M', planned: { reels: 2 }, brand: 'main' });
  const kerala = shoot({ _id: 'K', planned: { reels: 5 }, brand: 'kerala' });
  const none = new Map();
  assert.equal(P.monthlyReport([main, kerala], none, '2026-11-30', 1, 'all')[0].planned, 7);
  assert.equal(P.monthlyReport([main, kerala], none, '2026-11-30', 1, 'kerala')[0].planned, 5);
  assert.equal(P.monthlyReport([main, kerala], none, '2026-11-30', 1, 'main')[0].shoots, 1);
});
