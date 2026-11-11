// Pure unit tests: node --test tests/ceoInbox.test.js
// What the CEO home asks the server for: the inbox shaping, the watch list, the daily digest line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { INBOX_SOURCES, shapeInbox, shapeSignals, npsOf, digestText } from '../services/ceoInbox.js';

const NOW = new Date('2026-11-06T10:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000);
const src = (key) => INBOX_SOURCES.find((s) => s.key === key);
const row = (key, count, { amount = 0, oldest = null } = {}) => ({ def: src(key), count, amount, oldest });

test('the sources: unique keys, the CEO\'s own ones first, and a route only where the CEO can open the screen', () => {
  const keys = INBOX_SOURCES.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(INBOX_SOURCES.filter((s) => s.owner === 'you').map((s) => s.key), ['project_proposals', 'ceo_decisions']);
  // the screens a CEO may open (their permissions); an operational screen they cannot open must not be linked
  const openable = new Set(['/projects', '/ceo/decisions', '/accounts/dashboard']);
  for (const s of INBOX_SOURCES) if (s.route) assert.ok(openable.has(s.route), `${s.key} links to ${s.route}`);
  for (const s of INBOX_SOURCES.filter((x) => x.owner === 'team')) assert.ok(s.withWhom, `${s.key} says who it is waiting with`);
});

test('only what is waiting is listed', () => {
  const r = shapeInbox([row('project_proposals', 0), row('admin_expenses', 3, { amount: 12000, oldest: daysAgo(4) })], NOW);
  assert.deepEqual(r.items.map((i) => i.key), ['admin_expenses']);
});

test('the CEO\'s own decisions come first, then the longest-waiting', () => {
  const r = shapeInbox(
    [
      row('collections', 2, { amount: 500, oldest: daysAgo(2) }),
      row('hr_approvals', 5, { oldest: daysAgo(9) }),
      row('ceo_decisions', 1, { amount: 250000, oldest: daysAgo(1) }),
      row('admin_expenses', 3, { amount: 9000, oldest: daysAgo(6) }),
      row('project_proposals', 2, { oldest: daysAgo(3) }),
    ],
    NOW,
  );
  assert.deepEqual(r.items.map((i) => i.key), ['project_proposals', 'ceo_decisions', 'hr_approvals', 'admin_expenses', 'collections']);
});

test('counts, amounts and ages: what needs you, what is with the team, how old the oldest is', () => {
  const r = shapeInbox(
    [
      row('project_proposals', 2, { oldest: daysAgo(3) }),
      row('ceo_decisions', 1, { amount: 250000.456, oldest: daysAgo(1) }),
      row('admin_expenses', 3, { amount: 9000, oldest: daysAgo(6) }),
      row('hr_approvals', 5, { oldest: daysAgo(9) }),
    ],
    NOW,
  );
  assert.equal(r.needsYou, 3);
  assert.equal(r.withTeam, 8);
  assert.equal(r.oldestTeamDays, 9);
  const byKey = Object.fromEntries(r.items.map((i) => [i.key, i]));
  assert.equal(byKey.ceo_decisions.amount, 250000.46); // rounded to paise
  assert.equal(byKey.project_proposals.amount, null); // no money on a proposal
  assert.equal(byKey.admin_expenses.oldestDays, 6);
  assert.equal(byKey.admin_expenses.withWhom, 'Accounts');
  assert.equal(byKey.project_proposals.route, '/projects');
  assert.equal(byKey.hr_approvals.route, null);
});

test('nothing waiting: empty, zeros', () => {
  assert.deepEqual(shapeInbox([row('collections', 0)], NOW), { items: [], needsYou: 0, withTeam: 0, oldestTeamDays: 0 });
  assert.deepEqual(shapeInbox([], NOW).items, []);
});

test('an item with no known age says so instead of guessing', () => {
  const r = shapeInbox([row('hiring_plans', 1)], NOW);
  assert.equal(r.items[0].oldestDays, null);
  assert.equal(r.oldestTeamDays, 0);
});

test('NPS: promoters (9–10) minus detractors (0–6), as a percentage of those who answered', () => {
  assert.equal(npsOf([10, 9, 9, 10]), 100);
  assert.equal(npsOf([10, 9, 8, 7, 6, 3]), 0); // 2 promoters, 2 detractors of 6
  assert.equal(npsOf([2, 4, 6]), -100);
  assert.equal(npsOf([8, 7]), 0); // passives only
  assert.equal(npsOf([]), null);
  assert.equal(npsOf([null, undefined]), null);
});

const base = { overdueProjects: 0, blockedOkrs: 0, atRiskMilestones: 0, lowStock: 0, cancelledThisMonth: 0, cancelledLastMonth: 0, npsNow: null, npsBefore: null };
const sig = (raw, key) => shapeSignals({ ...base, ...raw }).find((s) => s.key === key);

test('the watch list: all quiet', () => {
  const all = shapeSignals(base);
  assert.ok(all.every((s) => s.severity === 'ok'));
  assert.equal(all.find((s) => s.key === 'nps'), undefined); // nobody answered: no NPS tile
});

test('the watch list: a few of something is a watch, many an alert', () => {
  assert.equal(sig({ overdueProjects: 1 }, 'overdue_projects').severity, 'watch');
  assert.equal(sig({ overdueProjects: 3 }, 'overdue_projects').severity, 'alert');
  assert.equal(sig({ blockedOkrs: 2 }, 'blocked_okrs').severity, 'watch');
  assert.equal(sig({ atRiskMilestones: 2 }, 'at_risk_milestones').severity, 'alert');
  assert.equal(sig({ lowStock: 4 }, 'low_stock').severity, 'watch');
  assert.equal(sig({ lowStock: 10 }, 'low_stock').severity, 'alert');
});

test('the watch list: cancellations — up on last month is a watch, a clear jump an alert, a small jump is not', () => {
  assert.equal(sig({ cancelledThisMonth: 1, cancelledLastMonth: 0 }, 'cancellations').severity, 'watch');
  assert.equal(sig({ cancelledThisMonth: 2, cancelledLastMonth: 2 }, 'cancellations').severity, 'ok');
  assert.equal(sig({ cancelledThisMonth: 5, cancelledLastMonth: 3 }, 'cancellations').severity, 'alert');
  assert.equal(sig({ cancelledThisMonth: 2, cancelledLastMonth: 0 }, 'cancellations').severity, 'watch'); // under 3: not yet an alert
  assert.equal(sig({ cancelledThisMonth: 4, cancelledLastMonth: 6 }, 'cancellations').severity, 'ok');
  assert.equal(sig({ cancelledThisMonth: 4, cancelledLastMonth: 6 }, 'cancellations').previous, 6);
});

test('the watch list: NPS — a fall of 5 is a watch, 10 or a negative score an alert', () => {
  assert.equal(sig({ npsNow: 60, npsBefore: 62 }, 'nps').severity, 'ok');
  assert.equal(sig({ npsNow: 55, npsBefore: 61 }, 'nps').severity, 'watch');
  assert.equal(sig({ npsNow: 50, npsBefore: 61 }, 'nps').severity, 'alert');
  assert.equal(sig({ npsNow: -5, npsBefore: null }, 'nps').severity, 'alert');
  assert.equal(sig({ npsNow: 70, npsBefore: null }, 'nps').severity, 'ok'); // nothing to compare with
});

test('the watch list: worst first', () => {
  const list = shapeSignals({ ...base, overdueProjects: 1, blockedOkrs: 0, lowStock: 12, cancelledThisMonth: 0 });
  assert.deepEqual(list.map((s) => s.severity).slice(0, 2), ['alert', 'watch']);
  assert.equal(list[0].key, 'low_stock');
});

test('the daily digest line', () => {
  assert.equal(digestText({ needsYou: 0, withTeam: 0, oldestTeamDays: 0 }), null);
  assert.equal(digestText({ needsYou: 1, withTeam: 0, oldestTeamDays: 0 }), '1 thing needs your decision');
  assert.equal(digestText({ needsYou: 3, withTeam: 0, oldestTeamDays: 0 }), '3 things need your decision');
  assert.equal(digestText({ needsYou: 0, withTeam: 1, oldestTeamDays: 1 }), '1 approval is waiting with the team');
  assert.equal(digestText({ needsYou: 2, withTeam: 8, oldestTeamDays: 9 }), '2 things need your decision · 8 approvals are waiting with the team, the oldest 9 days');
});
