// Pure unit tests: node --test tests/marketingStrategyInput.test.js
// Checking what the app sends for initiatives, projects, plans, roadmap lines, findings and reviews.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanRangeQuery, cleanYear, cleanInitiativeInput, cleanProjectInput, cleanPlanInput, cleanRoadmapInput, cleanFindingInput, cleanReviewInput,
  cleanActionStatus, cleanTick, cleanPaging,
} from '../utils/marketingStrategyInput.js';

const ID = '64b7f0c2a1b2c3d4e5f60718';
const TODAY = '2026-11-13';

test('range: this month by default; real days; a year at most; All / Main / Kerala', () => {
  assert.deepEqual(cleanRangeQuery({}, TODAY), { ok: true, value: { from: '2026-11-01', to: '2026-11-30', brand: 'all' } });
  assert.deepEqual(cleanRangeQuery({}, '2026-02-10').value, { from: '2026-02-01', to: '2026-02-28', brand: 'all' });
  assert.deepEqual(cleanRangeQuery({ from: '2026-01-01', to: '2026-03-31', brand: 'KERALA' }, TODAY).value, { from: '2026-01-01', to: '2026-03-31', brand: 'kerala' });
  assert.equal(cleanRangeQuery({ from: 'bad' }, TODAY).ok, false);
  assert.equal(cleanRangeQuery({ from: '2026-02-30' }, TODAY).ok, false);
  assert.equal(cleanRangeQuery({ from: '2026-11-10', to: '2026-11-01' }, TODAY).ok, false);
  assert.equal(cleanRangeQuery({ from: '2025-01-01', to: '2026-11-01' }, TODAY).ok, false, 'more than a year');
  assert.equal(cleanRangeQuery({ brand: 'mars' }, TODAY).field, 'brand');
});

test('year: 2000–2100 or the fallback', () => {
  assert.deepEqual(cleanYear(undefined, 2026), { ok: true, value: 2026 });
  assert.deepEqual(cleanYear('2027', 2026), { ok: true, value: 2027 });
  for (const bad of ['1999', '2101', 'x', '2026.5']) assert.equal(cleanYear(bad, 2026).ok, false, bad);
});

test('initiative: a new one needs a title; every field is checked; an update changes only what was sent', () => {
  assert.equal(cleanInitiativeInput({}).field, 'title');
  assert.equal(cleanInitiativeInput({ title: 'x' }).ok, false);
  const r = cleanInitiativeInput({ title: ' Launch Bridal Campaign v2 ', focusArea: ' Revenue & Lead Growth ', brand: 'kerala', impact: 'high', startDate: '2026-11-01', dueDate: '2026-11-15', progress: '40', ownerId: ID, planId: ID, description: ' d ', notes: ' n ' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { title: 'Launch Bridal Campaign v2', focusArea: 'Revenue & Lead Growth', brand: 'kerala', impact: 'high', startDate: '2026-11-01', dueDate: '2026-11-15', progress: 40, ownerId: ID, planId: ID, description: 'd', notes: 'n' });
  assert.deepEqual(cleanInitiativeInput({ progress: 55 }, { title: 'Old' }).value, { progress: 55 });
  assert.deepEqual(cleanInitiativeInput({}, { title: 'Old' }).value, {}, 'nothing sent, nothing changed');
  for (const body of [{ brand: 'mars' }, { status: 'done' }, { impact: 'huge' }, { startDate: '2026-02-30' }, { dueDate: 'soon' }, { progress: 101 }, { progress: -1 }, { progress: 12.5 }, { progress: 'abc' }, { ownerId: 'nope' }, { planId: '123' }]) {
    assert.equal(cleanInitiativeInput(body, { title: 'Old' }).ok, false, JSON.stringify(body));
  }
});

test('initiative: blank values clear a date, a progress, an owner and a plan; the due day cannot be before the start', () => {
  assert.deepEqual(cleanInitiativeInput({ dueDate: '', startDate: null, progress: '', ownerId: '', planId: null }, { title: 'Old' }).value, { dueDate: null, startDate: null, progress: null, ownerId: null, planId: null });
  assert.equal(cleanInitiativeInput({ title: 'A b', startDate: '2026-11-10', dueDate: '2026-11-09' }).ok, false);
  assert.equal(cleanInitiativeInput({ title: 'A b', startDate: '2026-11-10', dueDate: '2026-11-10' }).ok, true, 'the same day is fine');
  assert.equal(cleanInitiativeInput({ dueDate: '2026-11-01' }, { title: 'Old', startDate: '2026-11-10' }).field, 'dueDate', 'checked against the stored start day');
  assert.equal(cleanInitiativeInput({ startDate: '2026-11-20' }, { title: 'Old', dueDate: '2026-11-10' }).field, 'dueDate');
  assert.equal(cleanInitiativeInput({ startDate: '2026-11-20', dueDate: null }, { title: 'Old', dueDate: '2026-11-10' }).ok, true, 'clearing the due day while moving the start');
});

test('initiative: texts are data — trimmed and capped', () => {
  const r = cleanInitiativeInput({ title: `  ${'x'.repeat(400)}  `, notes: 'n'.repeat(5000), description: 'd'.repeat(5000), focusArea: 'f'.repeat(500) });
  assert.equal(r.value.title.length, 200);
  assert.equal(r.value.notes.length, 2000);
  assert.equal(r.value.description.length, 1000);
  assert.equal(r.value.focusArea.length, 120);
  assert.equal(cleanInitiativeInput({ title: '<script>alert(1)</script>' }).value.title, '<script>alert(1)</script>', 'kept as text; it is never rendered as markup');
});

test('project: a new one needs a name; the due day is endDate; status follows the project statuses', () => {
  assert.equal(cleanProjectInput({}).field, 'name');
  const r = cleanProjectInput({ name: ' Website v2 ', category: ' Technology ', startDate: '2026-10-01', endDate: '2026-11-15', ownerId: ID, progress: 85, status: 'on_hold' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { name: 'Website v2', category: 'Technology', startDate: '2026-10-01', endDate: '2026-11-15', ownerId: ID, progress: 85, status: 'on_hold' });
  assert.equal(cleanProjectInput({ status: 'active' }, { name: 'Old' }).ok, false, 'active is an initiative status, not a project one');
  assert.equal(cleanProjectInput({ name: 'A b', startDate: '2026-11-10', endDate: '2026-11-09' }).field, 'endDate');
  assert.equal(cleanProjectInput({ category: 'c'.repeat(300) }, { name: 'Old' }).value.category.length, 80);
});

test('plan: needs a title, a focus area and a year; goals are a short list of texts', () => {
  assert.equal(cleanPlanInput({ focusArea: 'Brand', year: 2026 }).field, 'title');
  assert.equal(cleanPlanInput({ title: 'Brand plan', year: 2026 }).field, 'focusArea');
  assert.equal(cleanPlanInput({ title: 'Brand plan', focusArea: 'Brand' }).field, 'year');
  assert.equal(cleanPlanInput({ title: 'Brand plan', focusArea: 'Brand', year: 1990 }).field, 'year');
  const r = cleanPlanInput({ title: 'Brand plan', focusArea: ' Brand Growth ', year: '2026', status: 'in_progress', goals: [' Increase leads ', '', '  ', 'Improve engagement'], ownerId: ID, brand: 'main', description: 'd' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { title: 'Brand plan', focusArea: 'Brand Growth', year: 2026, status: 'in_progress', goals: ['Increase leads', 'Improve engagement'], ownerId: ID, brand: 'main', description: 'd' });
  assert.equal(cleanPlanInput({ title: 'Brand plan', focusArea: 'Brand', year: 2026, goals: 'one' }).field, 'goals');
  assert.equal(cleanPlanInput({ title: 'Brand plan', focusArea: 'Brand', year: 2026, goals: Array(13).fill('g') }).field, 'goals');
  assert.equal(cleanPlanInput({ title: 'Brand plan', focusArea: 'Brand', year: 2026, status: 'cancelled' }).field, 'status', 'a plan is deleted, not cancelled');
  assert.deepEqual(cleanPlanInput({ status: 'completed' }, { title: 'Old' }).value, { status: 'completed' });
  assert.equal(cleanPlanInput({ focusArea: '  ' }, { title: 'Old' }).field, 'focusArea', 'a focus area cannot be blanked');
  assert.equal(cleanPlanInput({ goals: [`${'g'.repeat(300)}`] }, { title: 'Old' }).value.goals[0].length, 200);
});

test('roadmap line: a title, a year and a quarter 1–4; the theme is free text; links are ids', () => {
  assert.equal(cleanRoadmapInput({ year: 2026, quarter: 1 }).field, 'title');
  assert.equal(cleanRoadmapInput({ title: 'Brand consolidation', quarter: 1 }).field, 'year');
  for (const q of [0, 5, 'x', 1.5, null]) assert.equal(cleanRoadmapInput({ title: 'Brand consolidation', year: 2026, quarter: q }).field, 'quarter', String(q));
  const r = cleanRoadmapInput({ title: ' Brand consolidation ', year: 2026, quarter: '2', theme: ' Growth ', planId: ID, initiativeId: ID, brand: 'kerala' });
  assert.deepEqual(r.value, { title: 'Brand consolidation', year: 2026, quarter: 2, theme: 'Growth', planId: ID, initiativeId: ID, brand: 'kerala' });
  assert.deepEqual(cleanRoadmapInput({ quarter: 3 }, { title: 'Old' }).value, { quarter: 3 });
  assert.equal(cleanRoadmapInput({ title: 'Brand consolidation', year: 2026, quarter: 1, planId: 'nope' }).field, 'planId');
});

test('finding: a title and a kind; the day defaults to today; the link must be http(s); tags are a short lowercase list', () => {
  const ok = cleanFindingInput({ title: 'Bridal search up 32%', kind: 'market_insight', summary: ' s ', link: 'https://drive.google.com/x', brand: 'kerala', date: '2026-11-10', tags: ['Bridal', ' bridal ', 'Kerala'] }, null, { today: TODAY });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { title: 'Bridal search up 32%', kind: 'market_insight', summary: 's', link: 'https://drive.google.com/x', brand: 'kerala', date: '2026-11-10', tags: ['bridal', 'kerala'] });
  assert.equal(cleanFindingInput({ title: 'A finding', kind: 'report' }, null, { today: TODAY }).value.date, TODAY);
  assert.equal(cleanFindingInput({ kind: 'report' }, null, { today: TODAY }).field, 'title');
  assert.equal(cleanFindingInput({ title: 'A finding' }, null, { today: TODAY }).field, 'kind');
  assert.equal(cleanFindingInput({ title: 'A finding', kind: 'rumour' }, null, { today: TODAY }).field, 'kind');
  assert.equal(cleanFindingInput({ title: 'A finding', kind: 'report', date: '' }, null, { today: TODAY }).field, 'date', 'a blank day is not today');
  assert.equal(cleanFindingInput({ title: 'A finding', kind: 'report', date: '2026-13-01' }, null, { today: TODAY }).field, 'date');
  for (const link of ['javascript:alert(1)', 'file:///etc/passwd', 'not a link', 'data:text/html,hi']) assert.equal(cleanFindingInput({ title: 'A finding', kind: 'report', link }, null, { today: TODAY }).field, 'link', link);
  assert.equal(cleanFindingInput({ title: 'A finding', kind: 'report', link: '' }, null, { today: TODAY }).value.link, '', 'a blank link is allowed');
  assert.deepEqual(cleanFindingInput({ summary: 'new' }, { title: 'Old' }, { today: TODAY }).value, { summary: 'new' });
  assert.deepEqual(cleanFindingInput({ tags: 'a, b ,A' }, { title: 'Old' }, { today: TODAY }).value.tags, ['a', 'b'], 'a comma-separated string works too');
  assert.equal(cleanFindingInput({ title: 'A finding', kind: 'report', tags: Array(30).fill(0).map((_, i) => `t${i}`) }, null, { today: TODAY }).value.tags.length, 10);
});

test('review: a type, a period, a day, at least one outcome with a state; action items with owner, priority, day and status', () => {
  const body = { type: 'quarterly', periodLabel: ' Q3 2026 ', reviewDate: '2026-10-05', brand: 'main', summary: ' s ', outcomes: [{ text: ' Lead target achieved ', state: 'achieved' }, { text: 'Kerala expansion', state: 'partial' }, { text: '  ', state: 'missed' }], actionItems: [{ text: ' Finalise expansion ', ownerId: ID, priority: 'high', targetDate: '2026-11-20', status: 'in_progress' }, { text: 'Review budget' }] };
  const r = cleanReviewInput(body, null, { today: TODAY });
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(r.value.outcomes, [{ text: 'Lead target achieved', state: 'achieved' }, { text: 'Kerala expansion', state: 'partial' }], 'a blank outcome is dropped');
  assert.deepEqual(r.value.actionItems, [{ id: null, text: 'Finalise expansion', ownerId: ID, priority: 'high', targetDate: '2026-11-20', status: 'in_progress' }, { id: null, text: 'Review budget', ownerId: null, priority: 'medium', targetDate: null, status: 'open' }]);
  assert.equal(r.value.periodLabel, 'Q3 2026');
  assert.equal(cleanReviewInput({ ...body, reviewDate: undefined }, null, { today: TODAY }).value.reviewDate, TODAY);
  assert.equal(cleanReviewInput({ ...body, type: 'weekly' }, null, { today: TODAY }).field, 'type');
  assert.equal(cleanReviewInput({ ...body, periodLabel: ' ' }, null, { today: TODAY }).field, 'periodLabel');
  assert.equal(cleanReviewInput({ ...body, outcomes: [] }, null, { today: TODAY }).field, 'outcomes', 'the score is counted from the outcomes');
  assert.equal(cleanReviewInput({ ...body, outcomes: undefined }, null, { today: TODAY }).field, 'outcomes');
  assert.equal(cleanReviewInput({ ...body, outcomes: [{ text: 'x y', state: 'maybe' }] }, null, { today: TODAY }).field, 'outcomes');
  assert.equal(cleanReviewInput({ ...body, outcomes: 'x' }, null, { today: TODAY }).field, 'outcomes');
  assert.equal(cleanReviewInput({ ...body, outcomes: Array(31).fill({ text: 'x y', state: 'achieved' }) }, null, { today: TODAY }).field, 'outcomes');
  for (const bad of [{ text: 'x y', priority: 'urgent' }, { text: 'x y', status: 'stuck' }, { text: 'x y', targetDate: '2026-02-31' }, { text: 'x y', ownerId: 'nope' }]) assert.equal(cleanReviewInput({ ...body, actionItems: [bad] }, null, { today: TODAY }).field, 'actionItems', JSON.stringify(bad));
  assert.equal(cleanReviewInput({ ...body, actionItems: Array(31).fill({ text: 'x y' }) }, null, { today: TODAY }).field, 'actionItems');
  assert.deepEqual(cleanReviewInput({ summary: 'new' }, { type: 'quarterly' }, { today: TODAY }).value, { summary: 'new' }, 'an update changes only what was sent');
  assert.equal(cleanReviewInput({ outcomes: [] }, { type: 'quarterly' }, { today: TODAY }).field, 'outcomes', 'an update cannot empty the outcomes');
  assert.equal(cleanReviewInput({ actionItems: [{ id: ID, text: 'Keep me' }] }, { type: 'quarterly' }, { today: TODAY }).value.actionItems[0].id, ID, 'an id sent back keeps its place');
});

test('action status, tick and paging', () => {
  assert.deepEqual(cleanActionStatus({ status: 'done' }), { ok: true, value: { status: 'done' } });
  assert.equal(cleanActionStatus({ status: 'finished' }).ok, false);
  assert.equal(cleanActionStatus({}).field, 'status');
  assert.deepEqual(cleanTick({ done: true }).value, { done: true });
  assert.deepEqual(cleanTick({ done: false }).value, { done: false });
  for (const bad of [{}, { done: 'true' }, { done: 1 }, { done: null }]) assert.equal(cleanTick(bad).ok, false, JSON.stringify(bad));
  assert.deepEqual(cleanPaging({}), { page: 1, limit: 10 });
  assert.deepEqual(cleanPaging({ page: '3', limit: '25' }), { page: 3, limit: 25 });
  assert.deepEqual(cleanPaging({ page: '-4', limit: '5000' }), { page: 1, limit: 100 });
  assert.deepEqual(cleanPaging({ page: 'x', limit: '0' }, 8), { page: 1, limit: 8 }, '0 is not a size; the default applies');
});

test('a review may name the plan, project or initiative it is about — both parts, or both blank to take it away', () => {
  const base = { type: 'project', periodLabel: 'Website v2', reviewDate: '2026-11-10', outcomes: [{ text: 'Launched', state: 'achieved' }] };
  assert.deepEqual((({ linkKind, linkId }) => ({ linkKind, linkId }))(cleanReviewInput({ ...base, linkKind: 'project', linkId: ID }, null, { today: '2026-11-18' }).value), { linkKind: 'project', linkId: ID });
  assert.equal(cleanReviewInput({ ...base }, null, { today: '2026-11-18' }).value.linkKind, undefined, 'not sent → not touched');
  assert.equal(cleanReviewInput({ ...base, linkKind: 'campaign', linkId: ID }, null, { today: '2026-11-18' }).field, 'linkKind');
  assert.equal(cleanReviewInput({ ...base, linkKind: 'plan', linkId: 'nope' }, null, { today: '2026-11-18' }).field, 'linkId');
  assert.equal(cleanReviewInput({ ...base, linkKind: 'plan' }, null, { today: '2026-11-18' }).field, 'linkId');
  const cleared = cleanReviewInput({ linkKind: null, linkId: '' }, { ...base, linkKind: 'plan', linkId: ID }, { today: '2026-11-18' }).value;
  assert.deepEqual([cleared.linkKind, cleared.linkId], [null, null]);
});
