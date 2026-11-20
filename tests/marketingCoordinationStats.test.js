// Pure unit tests: node --test tests/marketingCoordinationStats.test.js
// How Coordinations counts: the request status machine, what is in scope for a date range, the headline figures (incl. approvals and the
// on-time rate), the department split, the handover board, approval decisions, meetings, follow-ups, upcoming items and key updates.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../utils/marketingCoordinationStats.js';

const TODAY = '2026-11-13'; // a Friday
const R = { from: '2026-11-09', to: '2026-11-15', brand: 'all', dept: 'all' }; // Monday–Sunday
let n = 0;
const req = (extra = {}) => ({ _id: `r${++n}`, kind: 'request', title: `Request ${n}`, fromDept: 'Marketing', toDept: 'Production', status: 'open', priority: 'medium', dueDate: null, progress: 0, brand: 'main', createdAt: '2026-11-10T05:00:00Z', closedAt: null, assigneeId: null, ...extra });
const app = (extra = {}) => ({ _id: `a${++n}`, title: `Approval ${n}`, category: 'Marketing', amount: 1000, status: 'pending', brand: 'main', dueDate: null, createdAt: '2026-11-10T05:00:00Z', decidedAt: null, requestId: null, ...extra });
const done = (extra = {}) => req({ status: 'completed', closedAt: '2026-11-11T05:00:00Z', progress: 100, ...extra });

test('the department list is fixed: the app shows the same ten teams', () => {
  assert.deepEqual(S.DEPARTMENTS, ['Production', 'Socials', 'Marketing', 'Sales', 'Operations', 'HR', 'Finance', 'IT', 'Design', 'Others']);
  assert.deepEqual(S.APPROVAL_CATEGORIES, [...S.DEPARTMENTS, 'Brand']);
  assert.deepEqual(S.REQUEST_STATUSES, ['open', 'in_progress', 'waiting_input', 'in_review', 'pending_approval', 'completed', 'cancelled']);
  assert.deepEqual(S.OPEN_STATUSES, ['open', 'in_progress', 'waiting_input', 'in_review', 'pending_approval']);
  assert.deepEqual(S.PENDING_STATUSES, ['open', 'waiting_input', 'in_review', 'pending_approval']);
  assert.deepEqual(S.AWAITING_APPROVAL, ['pending', 'in_review', 'escalated']);
});

test('the status machine: every move is either allowed or refused, as documented', () => {
  const allowed = {
    open: ['in_progress', 'completed', 'cancelled'],
    in_progress: ['waiting_input', 'in_review', 'pending_approval', 'completed', 'cancelled'],
    waiting_input: ['in_progress', 'in_review', 'pending_approval', 'completed', 'cancelled'],
    in_review: ['in_progress', 'waiting_input', 'pending_approval', 'completed', 'cancelled'],
    pending_approval: ['in_progress', 'waiting_input', 'in_review', 'completed', 'cancelled'],
    completed: ['in_progress'],
    cancelled: ['open'],
  };
  for (const from of S.REQUEST_STATUSES) {
    for (const to of S.REQUEST_STATUSES) {
      assert.equal(S.canMoveRequest(from, to), from === to || allowed[from].includes(to), `${from} → ${to}`);
    }
    assert.deepEqual(S.nextStatuses(from), allowed[from]);
  }
  assert.deepEqual(S.nextStatuses('nonsense'), []);
  assert.equal(S.canMoveRequest('nonsense', 'open'), false);
  assert.equal(S.canMoveRequest('in_progress', 'open'), false, 'work that has started cannot go back to open');
});

test('progress: completed is 100; a stage lifts the figure to its floor; reopening caps it; moving back never lowers it', () => {
  assert.equal(S.progressOf({ status: 'completed', progress: 20 }), 100);
  assert.equal(S.progressOf({ status: 'open', progress: 140 }), 100);
  assert.equal(S.progressOf({ status: 'open', progress: -5 }), 0);
  assert.equal(S.progressOf({ status: 'open', progress: 'x' }), 0);
  assert.equal(S.progressOf({ status: 'in_progress', progress: 33.4 }), 33);
  assert.equal(S.progressAfterMove('open', 'in_progress', 0), 10);
  assert.equal(S.progressAfterMove('in_progress', 'in_review', 30), 75);
  assert.equal(S.progressAfterMove('in_progress', 'pending_approval', 90), 90, 'never lowered');
  assert.equal(S.progressAfterMove('in_review', 'in_progress', 80), 80, 'moving back keeps it');
  assert.equal(S.progressAfterMove('in_progress', 'completed', 10), 100);
  assert.equal(S.progressAfterMove('completed', 'in_progress', 100), 90, 'reopened: capped at 90');
  assert.equal(S.progressAfterMove('in_progress', 'cancelled', 40), 40);
  assert.equal(S.progressAfterMove('cancelled', 'open', 40), 40);
});

test('scope: logged in the range, closed in it, or still open from before it; never cancelled; brand and department narrow', () => {
  const inRange = req();
  const closedIn = done({ createdAt: '2026-10-01T05:00:00Z', closedAt: '2026-11-12T05:00:00Z' });
  const carried = req({ createdAt: '2026-10-01T05:00:00Z', status: 'in_progress' });
  const oldDone = done({ createdAt: '2026-10-01T05:00:00Z', closedAt: '2026-10-20T05:00:00Z' });
  const future = req({ createdAt: '2026-11-20T05:00:00Z' });
  const cancelled = req({ status: 'cancelled' });
  const all = [inRange, closedIn, carried, oldDone, future, cancelled];
  assert.deepEqual(S.requestsInScope(all, R).map((r) => r._id), [inRange._id, closedIn._id, carried._id]);
  const kerala = req({ brand: 'kerala' });
  assert.deepEqual(S.requestsInScope([inRange, kerala], { ...R, brand: 'kerala' }).map((r) => r._id), [kerala._id]);
  assert.equal(S.requestsInScope([inRange, kerala], { ...R, brand: 'all' }).length, 2);
  const sales = req({ fromDept: 'Sales', toDept: 'IT' });
  assert.deepEqual(S.requestsInScope([inRange, sales], { ...R, dept: 'IT' }).map((r) => r._id), [sales._id], 'the receiving team matches');
  assert.deepEqual(S.requestsInScope([inRange, sales], { ...R, dept: 'Sales' }).map((r) => r._id), [sales._id], 'the requesting team matches');
  assert.deepEqual(S.requestsInScope([inRange, sales], { ...R, dept: 'HR' }), []);
});

test('scope: the IST day decides — 00:30 IST on the 9th is in a range starting the 9th, 23:30 IST on the 15th is in one ending the 15th', () => {
  const first = req({ createdAt: '2026-11-08T19:00:00Z' }); // 9 Nov 00:30 IST
  const last = req({ createdAt: '2026-11-15T18:00:00Z' }); // 15 Nov 23:30 IST
  const before = req({ createdAt: '2026-11-08T18:00:00Z', status: 'completed', closedAt: '2026-11-08T18:00:00Z' }); // 8 Nov 23:30 IST
  const after = req({ createdAt: '2026-11-15T18:30:00Z' }); // 16 Nov 00:00 IST
  assert.deepEqual(S.requestsInScope([first, last, before, after], R).map((r) => r._id), [first._id, last._id]);
  assert.equal(S.createdDay(first), '2026-11-09');
  assert.equal(S.closedDay({ closedAt: null }), null);
});

test('figures: total, completed, in progress, pending, overdue — and for requests alone total = in progress + pending + completed', () => {
  const list = [
    done(),
    done({ dueDate: '2026-11-12' }),
    req({ status: 'in_progress' }),
    req({ status: 'in_progress', dueDate: '2026-11-12' }), // overdue
    req({ status: 'open', dueDate: '2026-11-13' }), // due today is not overdue
    req({ status: 'waiting_input' }),
    req({ status: 'in_review' }),
    req({ status: 'pending_approval' }),
    req({ status: 'cancelled' }),
  ];
  const k = S.coordKpis({ requests: list, range: R, today: TODAY, includeApprovals: false });
  assert.equal(k.total, 8, 'cancelled counts nowhere');
  assert.equal(k.completed, 2);
  assert.equal(k.inProgress, 2);
  assert.equal(k.pending, 4);
  assert.equal(k.total, k.inProgress + k.pending + k.completed);
  assert.equal(k.overdue, 1);
  assert.equal(k.pendingApprovals, 1, 'a request waiting for approval');
  assert.equal(k.approvals, 0);
  assert.equal(k.requests, 8);
});

test('figures: an approval logged by a member counts toward the total, completed (approved), pending approvals and overdue', () => {
  const requests = [req({ status: 'in_progress' })];
  const approvals = [
    app({ status: 'pending' }),
    app({ status: 'in_review', dueDate: '2026-11-12' }), // overdue, awaiting
    app({ status: 'escalated' }),
    app({ status: 'approved', decidedAt: '2026-11-11T05:00:00Z' }),
    app({ status: 'rejected', decidedAt: '2026-11-11T05:00:00Z' }),
  ];
  const k = S.coordKpis({ requests, approvals, range: R, today: TODAY });
  assert.equal(k.requests, 1);
  assert.equal(k.approvals, 5);
  assert.equal(k.total, 6);
  assert.equal(k.completed, 1, 'only an approved approval completes; a rejected one is closed, not completed');
  assert.equal(k.pendingApprovals, 3, 'pending, in review and escalated await a decision');
  assert.equal(k.overdue, 1);
  assert.equal(k.inProgress, 1);
  const without = S.coordKpis({ requests, approvals, range: R, today: TODAY, includeApprovals: false });
  assert.equal(without.total, 1);
  assert.equal(without.pendingApprovals, 0);
});

test('figures: a request waiting for approval that has an awaiting approval record is counted once', () => {
  const r = req({ status: 'pending_approval' });
  const linked = app({ status: 'pending', requestId: r._id });
  assert.equal(S.coordKpis({ requests: [r], approvals: [linked], range: R, today: TODAY }).pendingApprovals, 1);
  assert.equal(S.coordKpis({ requests: [r], approvals: [], range: R, today: TODAY }).pendingApprovals, 1);
  const decided = app({ status: 'approved', requestId: r._id, decidedAt: '2026-11-11T05:00:00Z' });
  assert.equal(S.coordKpis({ requests: [r], approvals: [decided], range: R, today: TODAY }).pendingApprovals, 1, 'a decided approval no longer covers the request');
});

test('figures: approvals follow the same scope rule (raised, decided in the range, or still waiting from before it)', () => {
  const a = [
    app(),
    app({ createdAt: '2026-10-01T05:00:00Z', status: 'approved', decidedAt: '2026-11-12T05:00:00Z' }),
    app({ createdAt: '2026-10-01T05:00:00Z', status: 'pending' }),
    app({ createdAt: '2026-10-01T05:00:00Z', status: 'approved', decidedAt: '2026-10-05T05:00:00Z' }),
    app({ createdAt: '2026-11-20T05:00:00Z' }),
    app({ category: 'HR' }),
  ];
  assert.equal(S.approvalsInScope(a, R).length, 4);
  assert.equal(S.approvalsInScope(a, { ...R, dept: 'HR' }).length, 1);
  assert.equal(S.approvalsInScope([app({ brand: 'kerala' }), app()], { ...R, brand: 'kerala' }).length, 1);
});

test('on-time rate: completed requests with a due day closed on or before it, with decided approvals; null when none has a due day', () => {
  const list = [
    done({ dueDate: '2026-11-11' }), // closed on the 11th: on time (the boundary)
    done({ dueDate: '2026-11-10' }), // closed on the 11th: late
    done({ dueDate: '2026-11-14' }), // early
    done(), // no due day: not part of the rate
  ];
  const k = S.coordKpis({ requests: list, range: R, today: TODAY, includeApprovals: false });
  assert.equal(k.onTimeRate, 67);
  assert.equal(k.onTimeOf, 3);
  assert.equal(S.coordKpis({ requests: [done()], range: R, today: TODAY }).onTimeRate, null);
  assert.equal(S.coordKpis({ requests: [], range: R, today: TODAY }).onTimeRate, null);
  assert.equal(S.completedOnTime(done({ dueDate: '2026-11-11' })), true);
  assert.equal(S.completedOnTime(done({ dueDate: '2026-11-10' })), false);
  assert.equal(S.completedOnTime(req({ status: 'in_progress', dueDate: '2026-11-20' })), false);
  // an approval decided on or before its needed-by day counts too
  const withApproval = S.coordKpis({ requests: [done({ dueDate: '2026-11-10' })], approvals: [app({ status: 'approved', dueDate: '2026-11-12', decidedAt: '2026-11-11T05:00:00Z' }), app({ status: 'rejected', dueDate: '2026-11-10', decidedAt: '2026-11-11T05:00:00Z' })], range: R, today: TODAY });
  assert.equal(withApproval.onTimeOf, 3);
  assert.equal(withApproval.onTimeRate, 33);
  // the IST day of the closing moment decides: 23:30 IST on the due day is on time
  assert.equal(S.completedOnTime(done({ dueDate: '2026-11-11', closedAt: '2026-11-11T18:00:00Z' })), true);
  assert.equal(S.completedOnTime(done({ dueDate: '2026-11-11', closedAt: '2026-11-11T18:30:00Z' })), false, '00:00 IST the next day is late');
});

test('overdue: open and due before today; due today, completed and cancelled are not overdue', () => {
  assert.equal(S.isOverdue(req({ dueDate: '2026-11-12' }), TODAY), true);
  assert.equal(S.isOverdue(req({ dueDate: '2026-11-13' }), TODAY), false);
  assert.equal(S.isOverdue(req({ dueDate: null }), TODAY), false);
  assert.equal(S.isOverdue(done({ dueDate: '2026-11-01' }), TODAY), false);
  assert.equal(S.isOverdue(req({ status: 'cancelled', dueDate: '2026-11-01' }), TODAY), false);
  assert.equal(S.isOverdue(req({ status: 'pending_approval', dueDate: '2026-11-01' }), TODAY), true);
});

test('change on the period before; nothing to compare with is null', () => {
  assert.deepEqual(S.kpiChange({ total: 12, completed: 6 }, { total: 10, completed: 3 }), { total: 20, completed: 100 });
  assert.deepEqual(S.kpiChange({ total: 5, completed: 0 }, { total: 0, completed: 0 }), { total: null, completed: null });
});

test('the task table tabs: mine = assigned to me, team = assigned to any marketing member, all = everything', () => {
  const mine = req({ assigneeId: 'm1' });
  const other = req({ assigneeId: 'm2' });
  const outside = req({ assigneeId: null });
  const list = [mine, other, outside];
  assert.deepEqual(S.tabFilter(list, 'my', 'm1'), [mine]);
  assert.deepEqual(S.tabFilter(list, 'team', 'm1'), [mine, other]);
  assert.deepEqual(S.tabFilter(list, 'all', 'm1'), list);
  assert.deepEqual(S.tabFilter(list, 'my', ''), [], 'someone who is not on the team has no tasks of their own');
  assert.deepEqual(S.tabCounts(list, 'm1'), { my: 1, team: 2, all: 3 });
  assert.equal(S.tabFilter([req({ assigneeId: { _id: 'm1' } })], 'my', 'm1').length, 1, 'a populated reference works too');
});

test('the status filter: one status, the pending group, overdue, or all', () => {
  const list = [req({ status: 'open' }), req({ status: 'in_progress' }), req({ status: 'waiting_input' }), done(), req({ status: 'in_progress', dueDate: '2026-11-01' })];
  assert.equal(S.statusFilter(list, 'all', TODAY).length, 5);
  assert.equal(S.statusFilter(list, undefined, TODAY).length, 5);
  assert.equal(S.statusFilter(list, 'in_progress', TODAY).length, 2);
  assert.equal(S.statusFilter(list, 'pending', TODAY).length, 2);
  assert.equal(S.statusFilter(list, 'overdue', TODAY).length, 1);
  assert.equal(S.statusFilter(list, 'completed', TODAY).length, 1);
});

test('sorting: open work before completed, soonest due first, no due day last, then newest', () => {
  const a = req({ dueDate: '2026-11-20', title: 'a' });
  const b = req({ dueDate: '2026-11-14', title: 'b' });
  const c = req({ dueDate: null, title: 'c', createdAt: '2026-11-11T05:00:00Z' });
  const d = req({ dueDate: null, title: 'd', createdAt: '2026-11-12T05:00:00Z' });
  const e = done({ dueDate: '2026-11-01', title: 'e' });
  assert.deepEqual(S.sortRequests([e, a, c, d, b]).map((r) => r.title), ['b', 'a', 'd', 'c', 'e']);
});

test('Request by Department: requesting, receiving or both; the biggest five and Others; each request once per team', () => {
  const list = [
    req({ fromDept: 'Marketing', toDept: 'Production' }),
    req({ fromDept: 'Marketing', toDept: 'Production' }),
    req({ fromDept: 'Production', toDept: 'Socials' }),
    req({ fromDept: 'Sales', toDept: 'Sales' }), // the same team on both sides counts once under "both"
  ];
  const both = S.departmentBreakdown(list, 'both');
  assert.equal(both.total, 4, 'the centre is the number of requests');
  assert.deepEqual(both.rows.map((r) => [r.label, r.count]), [['Production', 3], ['Marketing', 2], ['Socials', 1], ['Sales', 1]], 'ties follow the department list');
  assert.equal(both.rows[0].pct, 43, '3 of 7 mentions');
  const from = S.departmentBreakdown(list, 'requesting');
  assert.deepEqual(from.rows.map((r) => [r.label, r.count]), [['Marketing', 2], ['Production', 1], ['Sales', 1]]);
  assert.deepEqual(from.rows.map((r) => r.pct), [50, 25, 25]);
  const to = S.departmentBreakdown(list, 'receiving');
  assert.deepEqual(to.rows.map((r) => [r.label, r.count]), [['Production', 2], ['Socials', 1], ['Sales', 1]]);
  assert.deepEqual(S.departmentBreakdown([], 'both'), { by: 'both', total: 0, rows: [], others: [] });
});

test('Request by Department: more than five teams → the rest are merged into Others (with the real "Others" team)', () => {
  const mk = (to, times) => Array.from({ length: times }, () => req({ fromDept: 'Marketing', toDept: to }));
  const list = [...mk('Production', 6), ...mk('Socials', 5), ...mk('Sales', 4), ...mk('Operations', 3), ...mk('HR', 2), ...mk('Finance', 1), ...mk('IT', 1), ...mk('Others', 2)];
  const rows = S.departmentBreakdown(list, 'receiving').rows;
  assert.deepEqual(rows.map((r) => [r.label, r.count]), [['Production', 6], ['Socials', 5], ['Sales', 4], ['Operations', 3], ['HR', 2], ['Others', 4]]);
  assert.deepEqual(S.departmentBreakdown(list, 'receiving').others, ['Finance', 'IT', 'Others'].sort());
  assert.equal(rows.reduce((s, r) => s + r.count, 0), 24);
});

test('the handover board: a status belongs to one column; a column has a status to move to', () => {
  const stage = { open: 'requested', in_progress: 'in_progress', waiting_input: 'in_progress', in_review: 'in_review', pending_approval: 'in_review', completed: 'completed', cancelled: null };
  for (const [status, key] of Object.entries(stage)) assert.equal(S.handoverStage(status), key, status);
  assert.equal(S.statusForStage('requested'), 'open');
  assert.equal(S.statusForStage('in_progress'), 'in_progress');
  assert.equal(S.statusForStage('in_review'), 'in_review');
  assert.equal(S.statusForStage('completed'), 'completed');
  assert.equal(S.statusForStage('elsewhere'), null);
  assert.deepEqual(S.HANDOVER_STAGES.map((s) => s.label), ['Requested', 'In Progress', 'In Review', 'Completed']);
});

test('handover KPIs: active, awaiting action, in review, overdue, completed', () => {
  const list = [
    req({ kind: 'handover', status: 'open' }),
    req({ kind: 'handover', status: 'open', dueDate: '2026-11-01' }),
    req({ kind: 'handover', status: 'waiting_input' }),
    req({ kind: 'handover', status: 'in_progress' }),
    req({ kind: 'handover', status: 'in_review' }),
    req({ kind: 'handover', status: 'pending_approval' }),
    done({ kind: 'handover' }),
  ];
  assert.deepEqual(S.handoverKpis(list, TODAY), { active: 6, awaitingAction: 3, inReview: 2, overdue: 1, completed: 1 });
  assert.deepEqual(S.handoverKpis([], TODAY), { active: 0, awaitingAction: 0, inReview: 0, overdue: 0, completed: 0 });
});

test('handover columns: grouped by stage, soonest due first, completed newest first', () => {
  const a = req({ kind: 'handover', status: 'open', dueDate: '2026-11-20', title: 'a' });
  const b = req({ kind: 'handover', status: 'open', dueDate: '2026-11-14', title: 'b' });
  const c = req({ kind: 'handover', status: 'waiting_input', title: 'c' });
  const d1 = done({ kind: 'handover', closedAt: '2026-11-10T05:00:00Z', title: 'd1' });
  const d2 = done({ kind: 'handover', closedAt: '2026-11-12T05:00:00Z', title: 'd2' });
  const cols = S.handoverColumns([a, b, c, d1, d2]);
  assert.deepEqual(cols.map((x) => [x.key, x.count]), [['requested', 2], ['in_progress', 1], ['in_review', 0], ['completed', 2]]);
  assert.deepEqual(cols[0].items.map((r) => r.title), ['b', 'a']);
  assert.deepEqual(cols[3].items.map((r) => r.title), ['d2', 'd1']);
});

test('approval decisions: who can go where; approved and rejected are final', () => {
  const t = (status, decision) => S.approvalNext(status, decision);
  assert.equal(t('pending', 'review'), 'in_review');
  assert.equal(t('in_review', 'review'), null);
  assert.equal(t('escalated', 'review'), null);
  for (const from of ['pending', 'in_review', 'escalated']) {
    assert.equal(t(from, 'approve'), 'approved', from);
    assert.equal(t(from, 'reject'), 'rejected', from);
  }
  assert.equal(t('pending', 'escalate'), 'escalated');
  assert.equal(t('in_review', 'escalate'), 'escalated');
  assert.equal(t('escalated', 'escalate'), null, 'already escalated');
  for (const decision of ['review', 'approve', 'reject', 'escalate']) {
    assert.equal(t('approved', decision), null, `approved is final: ${decision}`);
    assert.equal(t('rejected', decision), null, `rejected is final: ${decision}`);
  }
  assert.equal(t('pending', 'whatever'), null);
});

test('approvals tab and KPI strip: Pending · In Review (with escalated) · Approved · Rejected; the amount still waiting', () => {
  const list = [
    app({ status: 'pending', amount: 20000 }),
    app({ status: 'pending', amount: 3000 }),
    app({ status: 'in_review', amount: 8500 }),
    app({ status: 'escalated', amount: 45000 }),
    app({ status: 'approved', amount: 12000 }),
    app({ status: 'rejected', amount: 700 }),
  ];
  assert.deepEqual(S.approvalKpis(list), { total: 6, pending: 2, inReview: 1, escalated: 1, approved: 1, rejected: 1, awaitingAmount: 76500 });
  assert.deepEqual(S.approvalTabCounts(list), { pending: 2, in_review: 2, approved: 1, rejected: 1 });
  assert.deepEqual(['pending', 'in_review', 'escalated', 'approved', 'rejected'].map(S.approvalTab), ['pending', 'in_review', 'in_review', 'approved', 'rejected']);
  assert.deepEqual(S.approvalKpis([]), { total: 0, pending: 0, inReview: 0, escalated: 0, approved: 0, rejected: 0, awaitingAmount: 0 });
});

test('content awaiting review: posts in review and assets in review only, brand narrowed, oldest first, with where to decide', () => {
  const content = [
    { _id: 'c1', title: 'Bridal reel', status: 'in-review', brand: 'main', platform: 'instagram', contentType: 'reel', scheduledDate: '2026-11-14T05:00:00Z', thumbUrl: 'https://x.test/t.jpg' },
    { _id: 'c2', title: 'Scheduled post', status: 'scheduled', brand: 'main', scheduledDate: '2026-11-10T05:00:00Z' },
    { _id: 'c3', title: 'Kerala story', status: 'in-review', brand: 'kerala', platform: 'facebook', scheduledDate: '2026-11-12T05:00:00Z' },
  ];
  const assets = [
    { _id: 'a1', title: 'Final cut', stage: 'in_review', brand: 'main', kind: 'reel', createdAt: '2026-11-11T05:00:00Z' },
    { _id: 'a2', title: 'Raw clip', stage: 'raw', brand: 'main', kind: 'bts', createdAt: '2026-11-01T05:00:00Z' },
  ];
  const all = S.reviewQueue({ content, assets });
  assert.deepEqual(all.map((x) => x.id), ['a1', 'c3', 'c1'], 'oldest first, across posts and assets');
  assert.equal(all.find((x) => x.id === 'c1').link, '/marketing/socials?tab=publishing');
  assert.equal(all.find((x) => x.id === 'a1').link, '/marketing/portfolio?tab=gallery');
  assert.equal(all.find((x) => x.id === 'c1').label, 'instagram · reel');
  assert.equal(all.find((x) => x.id === 'c1').thumbUrl, 'https://x.test/t.jpg');
  assert.deepEqual(S.reviewQueue({ content, assets, brand: 'kerala' }).map((x) => x.id), ['c3']);
  assert.deepEqual(S.reviewQueue({}), []);
});

test('dates: IST time, the week of a day, the end of a month and of a period', () => {
  assert.equal(S.istTime('2026-11-13T05:30:00Z'), '11:00');
  assert.equal(S.istTime('2026-11-13T18:45:00Z'), '00:15', 'past midnight IST');
  assert.deepEqual(S.weekRange('2026-11-13'), { from: '2026-11-09', to: '2026-11-15' });
  assert.deepEqual(S.weekRange('2026-11-15'), { from: '2026-11-09', to: '2026-11-15' }, 'Sunday is the last day');
  assert.deepEqual(S.weekRange('2026-11-16'), { from: '2026-11-16', to: '2026-11-22' });
  assert.equal(S.monthEnd('2026-11-13'), '2026-11-30');
  assert.equal(S.monthEnd('2026-02-01'), '2026-02-28');
  assert.equal(S.monthEnd('2028-02-10'), '2028-02-29');
  assert.equal(S.monthEnd('2026-12-31'), '2026-12-31');
  assert.equal(S.periodEnd('2026-11-13', 'today'), '2026-11-13');
  assert.equal(S.periodEnd('2026-11-13', 'week'), '2026-11-15');
  assert.equal(S.periodEnd('2026-11-13', 'month'), '2026-11-30');
  assert.equal(S.periodEnd('2026-11-13', 'anything'), '2026-11-15');
});

const NOW = new Date('2026-11-13T06:00:00Z'); // 11:30 IST
const meeting = (extra = {}) => ({ _id: `m${++n}`, title: `Meeting ${n}`, status: 'upcoming', brand: 'main', departments: [], startAt: '2026-11-13T09:00:00Z', endAt: '2026-11-13T10:00:00Z', ...extra });

test('a meeting is upcoming, live, to close, completed or cancelled — at the exact boundaries too', () => {
  const m = meeting({ startAt: '2026-11-13T06:00:00Z', endAt: '2026-11-13T07:00:00Z' });
  assert.equal(S.meetingState(m, new Date('2026-11-13T05:59:59Z')), 'upcoming');
  assert.equal(S.meetingState(m, new Date('2026-11-13T06:00:00Z')), 'live', 'it starts now');
  assert.equal(S.meetingState(m, new Date('2026-11-13T07:00:00Z')), 'live', 'it ends now');
  assert.equal(S.meetingState(m, new Date('2026-11-13T07:00:01Z')), 'to_close');
  assert.equal(S.meetingState({ ...m, status: 'completed' }, new Date('2026-11-20T00:00:00Z')), 'completed');
  assert.equal(S.meetingState({ ...m, status: 'cancelled' }, new Date('2026-11-01T00:00:00Z')), 'cancelled');
});

test('meeting KPIs: total (not cancelled, in the range), this week (always the week of today), completed, upcoming (incl. live), to close', () => {
  const list = [
    meeting(), // today 14:30 IST: upcoming
    meeting({ startAt: '2026-11-13T05:00:00Z', endAt: '2026-11-13T07:00:00Z' }), // live
    meeting({ startAt: '2026-11-11T05:00:00Z', endAt: '2026-11-11T06:00:00Z', status: 'completed' }),
    meeting({ startAt: '2026-11-10T05:00:00Z', endAt: '2026-11-10T06:00:00Z' }), // ended, never closed
    meeting({ startAt: '2026-11-12T05:00:00Z', endAt: '2026-11-12T06:00:00Z', status: 'cancelled' }),
    meeting({ startAt: '2026-11-25T05:00:00Z', endAt: '2026-11-25T06:00:00Z' }), // outside the week
    meeting({ brand: 'kerala' }),
  ];
  const k = S.meetingKpis(list, R, { today: TODAY, now: NOW });
  assert.deepEqual(k, { total: 5, thisWeek: 5, completed: 1, upcoming: 3, toClose: 1 });
  const month = S.meetingKpis(list, { from: '2026-11-01', to: '2026-11-30', brand: 'all', dept: 'all' }, { today: TODAY, now: NOW });
  assert.equal(month.total, 6);
  assert.equal(month.thisWeek, 5, 'the strip says this week whatever range is chosen');
  const kerala = S.meetingKpis(list, { ...R, brand: 'kerala' }, { today: TODAY, now: NOW });
  assert.deepEqual([kerala.total, kerala.thisWeek], [1, 1]);
  assert.deepEqual(S.meetingKpis([], R, { today: TODAY, now: NOW }), { total: 0, thisWeek: 0, completed: 0, upcoming: 0, toClose: 0 });
});

test('meetings narrowed by department and by the IST day of the start', () => {
  const sales = meeting({ departments: ['Sales', 'Marketing'] });
  const none = meeting({ departments: [] });
  assert.deepEqual(S.meetingsInRange([sales, none], { ...R, dept: 'Sales' }).map((m) => m._id), [sales._id]);
  assert.equal(S.meetingsInRange([sales, none], R).length, 2);
  const lateNight = meeting({ startAt: '2026-11-15T18:30:00Z', endAt: '2026-11-15T19:30:00Z' }); // 16 Nov 00:00 IST
  const early = meeting({ startAt: '2026-11-08T19:00:00Z', endAt: '2026-11-08T20:00:00Z' }); // 9 Nov 00:30 IST
  assert.deepEqual(S.meetingsInRange([lateNight, early], R).map((m) => m._id), [early._id]);
});

test('an action item is done by its own flag — or by its follow-up once it has become one', () => {
  const fu = new Map([['f1', { status: 'done' }], ['f2', { status: 'open' }]]);
  assert.equal(S.actionItemDone({ done: false }, fu), false);
  assert.equal(S.actionItemDone({ done: true }, fu), true);
  assert.equal(S.actionItemDone({ done: false, followUpId: 'f1' }, fu), true);
  assert.equal(S.actionItemDone({ done: true, followUpId: 'f2' }, fu), false, 'the follow-up decides');
  assert.equal(S.actionItemDone({ done: true, followUpId: 'gone' }, fu), true, 'a deleted follow-up leaves the item as it was');
});

const fu = (extra = {}) => ({ _id: `f${++n}`, item: `Follow up ${n}`, department: 'Marketing', ownerId: 'm1', status: 'open', dueDate: '2026-11-14', brand: 'main', ...extra });

test('follow-up state: completed, overdue, due today, upcoming', () => {
  assert.equal(S.followUpState(fu({ status: 'done', dueDate: '2026-11-01' }), TODAY), 'completed');
  assert.equal(S.followUpState(fu({ dueDate: '2026-11-12' }), TODAY), 'overdue');
  assert.equal(S.followUpState(fu({ dueDate: '2026-11-13' }), TODAY), 'due_today');
  assert.equal(S.followUpState(fu({ dueDate: '2026-11-14' }), TODAY), 'upcoming');
});

test('follow-up scope and KPIs: due in the range, or open and overdue from before; total = completed + overdue + due today + upcoming', () => {
  const list = [
    fu({ dueDate: '2026-11-13' }), // due today
    fu({ dueDate: '2026-11-14' }), // upcoming
    fu({ dueDate: '2026-11-10' }), // overdue, in the range
    fu({ dueDate: '2026-10-20' }), // overdue from before the range: still shown
    fu({ dueDate: '2026-10-21', status: 'done' }), // done long ago: not shown
    fu({ dueDate: '2026-11-11', status: 'done' }), // completed in the range
    fu({ dueDate: '2026-11-30' }), // after the range
  ];
  const scoped = S.followUpsInScope(list, R, TODAY);
  assert.equal(scoped.length, 5);
  assert.deepEqual(S.followUpKpis(scoped, TODAY), { total: 5, dueToday: 1, upcoming: 1, overdue: 2, completed: 1 });
  const k = S.followUpKpis(scoped, TODAY);
  assert.equal(k.total, k.dueToday + k.upcoming + k.overdue + k.completed);
  assert.equal(S.followUpsInScope(list, { ...R, dept: 'HR' }, TODAY).length, 0);
  assert.equal(S.followUpsInScope([fu({ brand: 'kerala' })], { ...R, brand: 'main' }, TODAY).length, 0);
  assert.equal(S.followUpsInScope(list, { ...R, ownerId: 'm2' }, TODAY).length, 0);
  assert.equal(S.followUpsInScope(list, { ...R, ownerId: 'm1' }, TODAY).length, 5);
  assert.equal(S.followUpsInScope([fu({ ownerId: { _id: 'm1' } })], { ...R, ownerId: 'm1' }, TODAY).length, 1, 'a populated owner works');
  assert.equal(S.followUpsInScope([fu({ dueDate: '2026-11-15' }), fu({ dueDate: '2026-11-09' })], R, TODAY).length, 2, 'both ends of the range are in');
});

test('a range in the future does not pull in overdue follow-ups that are only overdue by that range', () => {
  const next = { from: '2026-11-16', to: '2026-11-22', brand: 'all', dept: 'all' };
  assert.equal(S.followUpsInScope([fu({ dueDate: '2026-11-14' })], next, TODAY).length, 0, 'due tomorrow is not overdue today');
  assert.equal(S.followUpsInScope([fu({ dueDate: '2026-11-12' })], next, TODAY).length, 1, 'but one overdue now is carried');
});

test('the overdue panel: open follow-ups past their day, longest overdue first, with days ago', () => {
  const list = [fu({ dueDate: '2026-11-12', item: 'a' }), fu({ dueDate: '2026-11-01', item: 'b' }), fu({ dueDate: '2026-11-13', item: 'c' }), fu({ dueDate: '2026-11-02', status: 'done', item: 'd' })];
  assert.deepEqual(S.overdueFollowUps(list, TODAY).map((f) => [f.item, f.daysAgo]), [['b', 12], ['a', 1]]);
});

test('the follow-up calendar: per day, how many are open, done and overdue', () => {
  const list = [fu({ dueDate: '2026-11-03' }), fu({ dueDate: '2026-11-03', status: 'done' }), fu({ dueDate: '2026-11-20' }), fu({ dueDate: '2026-11-13' })];
  assert.deepEqual(S.calendarDays(list, TODAY), [
    { day: '2026-11-03', total: 2, open: 1, done: 1, overdue: 1 },
    { day: '2026-11-13', total: 1, open: 1, done: 0, overdue: 0 },
    { day: '2026-11-20', total: 1, open: 1, done: 0, overdue: 0 },
  ]);
  assert.deepEqual(S.calendarDays([], TODAY), []);
});

test('upcoming coordinations: meetings that have not ended and open requests\' due days, soonest first, inside the period', () => {
  const meetings = [
    meeting({ title: 'Content sync', departments: ['Marketing', 'Socials'], startAt: '2026-11-13T05:30:00Z', endAt: '2026-11-13T06:30:00Z' }), // live now, 11:00 IST
    meeting({ title: 'Shoot logistics', startAt: '2026-11-14T09:30:00Z', endAt: '2026-11-14T10:30:00Z' }),
    meeting({ title: 'Ended', startAt: '2026-11-13T03:00:00Z', endAt: '2026-11-13T04:00:00Z' }),
    meeting({ title: 'Done', status: 'completed', startAt: '2026-11-13T09:00:00Z', endAt: '2026-11-13T10:00:00Z' }),
    meeting({ title: 'Too far', startAt: '2026-11-20T09:00:00Z', endAt: '2026-11-20T10:00:00Z' }),
  ];
  const requests = [
    req({ title: 'Due today', dueDate: '2026-11-13', fromDept: 'Production', toDept: 'Socials' }),
    req({ title: 'Due Saturday', dueDate: '2026-11-14' }),
    req({ title: 'Overdue', dueDate: '2026-11-12' }),
    done({ title: 'Completed', dueDate: '2026-11-14' }),
    req({ title: 'No day', dueDate: null }),
    req({ title: 'Cancelled', status: 'cancelled', dueDate: '2026-11-14' }),
  ];
  const items = S.upcomingItems({ meetings, requests, now: NOW, today: TODAY, until: '2026-11-15' });
  assert.deepEqual(items.map((i) => [i.type, i.title, i.day, i.time]), [
    ['meeting', 'Content sync', '2026-11-13', '11:00'],
    ['request', 'Due today', '2026-11-13', ''],
    ['meeting', 'Shoot logistics', '2026-11-14', '15:00'],
    ['request', 'Due Saturday', '2026-11-14', ''],
  ]);
  assert.equal(items[0].subtitle, 'Marketing, Socials');
  assert.equal(items[1].subtitle, 'Production → Socials');
  assert.equal(S.upcomingItems({ meetings, requests, now: NOW, today: TODAY, until: '2026-11-13' }).length, 2, 'the Today period');
  assert.equal(S.upcomingItems({ meetings, requests, now: NOW, today: TODAY, until: '2026-11-15', limit: 1 }).length, 1);
  assert.deepEqual(S.upcomingItems({ now: NOW, today: TODAY, until: '2026-11-15' }), []);
});

test('key updates: only what the data supports, in plain words', () => {
  const kpis = { total: 42, completed: 28, overdue: 0 };
  const quiet = S.keyUpdates({ kpis, awaiting: [], today: TODAY });
  assert.deepEqual(quiet, [
    { tone: 'info', text: '28 of 42 items completed (67%).' },
    { tone: 'good', text: 'Nothing is overdue.' },
    { tone: 'good', text: 'No approvals are waiting for a decision.' },
  ]);
  assert.equal(S.keyUpdates({ kpis: { total: 10, completed: 9, overdue: 0 }, awaiting: [], today: TODAY })[0].tone, 'good', '80% or more is good news');
  const busy = S.keyUpdates({
    kpis: { total: 5, completed: 1, overdue: 2 },
    awaiting: [{ status: 'pending', createdAt: '2026-11-01T05:00:00Z' }, { status: 'escalated', createdAt: '2026-11-12T05:00:00Z' }],
    nextMeeting: { title: 'Marketing Sync', day: TODAY, time: '11:00' },
    overdueFollowUps: 3,
    today: TODAY,
  });
  assert.deepEqual(busy.map((x) => x.text), [
    '1 of 5 items completed (20%).',
    '2 items overdue.',
    '2 approvals waiting for a decision, the oldest for 12 days.',
    '1 escalated approval needs attention.',
    'Next meeting: Marketing Sync, today at 11:00.',
    '3 follow-ups overdue.',
  ]);
  assert.deepEqual(busy.map((x) => x.tone), ['info', 'bad', 'warn', 'warn', 'info', 'bad']);
  assert.equal(S.keyUpdates({ kpis: { total: 1, completed: 0, overdue: 1 }, awaiting: [], today: TODAY })[1].text, '1 item overdue.');
  assert.equal(S.keyUpdates({ kpis: { total: 1, completed: 0, overdue: 0 }, awaiting: [{ status: 'pending', createdAt: '2026-11-12T05:00:00Z' }], today: TODAY })[2].text, '1 approval waiting for a decision.', 'a recent one is not "the oldest for…"');
  const empty = S.keyUpdates({ kpis: { total: 0, completed: 0, overdue: 0 }, awaiting: [], today: TODAY });
  assert.equal(empty[0].text, 'Nothing has been logged for this period yet.');
  assert.ok(!empty.some((x) => x.text === 'Nothing is overdue.'), 'no "nothing is overdue" about nothing');
  assert.equal(S.keyUpdates({ kpis, awaiting: [], nextMeeting: { title: 'Sync', day: '2026-11-14', time: '10:00' }, today: TODAY }).at(-1).text, 'Next meeting: Sync, 2026-11-14 at 10:00.');
});

// ── audit fixes (T10, C1, C2) ─────────────────────────────────────────────────

test('a Team Dashboard task is a row of the task table: Marketing to Marketing, its status read the request way, in scope by the request rule', () => {
  const t = { _id: 't1', title: 'Edit the reel', assigneeId: 'm1', status: 'blocked', priority: 'high', progress: 30, brand: 'kerala', dueDate: '2026-11-12', createdAt: '2026-11-10T05:00:00Z', completedAt: null };
  const row = S.taskAsRequest(t);
  assert.deepEqual([row.kind, row.fromDept, row.toDept, row.status, row.taskStatus, row.progress, row.closedAt], ['task', 'Marketing', 'Marketing', 'waiting_input', 'blocked', 30, null]);
  assert.deepEqual(['not_started', 'in_progress', 'pending', 'completed'].map((st) => S.taskAsRequest({ ...t, status: st, completedAt: '2026-11-11T05:00:00Z' }).status), ['open', 'in_progress', 'waiting_input', 'completed']);
  const done = S.taskAsRequest({ ...t, status: 'completed', completedAt: '2026-11-11T05:00:00Z' });
  assert.equal(done.closedAt, '2026-11-11T05:00:00Z');
  assert.equal(done.progress, 100);
  assert.equal(S.requestsInScope([row, done], R).length, 2);
  assert.equal(S.requestsInScope([row], { ...R, dept: 'Sales' }).length, 0, 'a team task is Marketing work');
  assert.deepEqual(S.tabCounts([row, req({ assigneeId: 'm2' })], 'm1'), { my: 1, team: 2, all: 2 }, 'it is in My Tasks of the person it is given to');
  assert.equal(S.isOverdue(row, TODAY), true, 'due the 12th, still open on the 13th');
});

test('escalation: "Escalated to …" names the leadership with their titles, then the Marketing Managers', () => {
  assert.equal(S.escalationLabel([]), '');
  assert.equal(S.escalationLabel([{ name: 'Anjali', title: 'CEO' }]), 'Escalated to Anjali (CEO)');
  assert.equal(S.escalationLabel([{ name: 'Anjali', title: 'CEO' }, { name: 'Rafeeq', title: 'Executive Director' }, { name: 'S', title: 'Marketing Manager' }, { name: 'T', title: 'Marketing Manager' }]), 'Escalated to Anjali (CEO), Rafeeq (Executive Director) and 2 Marketing Managers');
  assert.equal(S.escalationLabel([{ name: 'Salmaan', title: 'Marketing Manager' }]), 'Escalated to Salmaan (Marketing Manager)');
});

test('follow-up reminder: once per due day — due today, or overdue when first seen late; off, done or already reminded → nothing', () => {
  const f = (extra) => ({ reminder: true, status: 'open', dueDate: TODAY, remindedFor: null, ...extra });
  assert.equal(S.followUpReminderKind(f({}), TODAY), 'due');
  assert.equal(S.followUpReminderKind(f({ dueDate: '2026-11-10' }), TODAY), 'overdue');
  assert.equal(S.followUpReminderKind(f({ dueDate: '2026-11-14' }), TODAY), null, 'not due yet');
  assert.equal(S.followUpReminderKind(f({ reminder: false }), TODAY), null);
  assert.equal(S.followUpReminderKind(f({ status: 'done' }), TODAY), null);
  assert.equal(S.followUpReminderKind(f({ remindedFor: TODAY }), TODAY), null, 'already told for this due day');
  assert.equal(S.followUpReminderKind(f({ remindedFor: '2026-11-10' }), TODAY), 'due', 'the due day moved: a new reminder');
});
