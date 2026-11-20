// Pure unit tests: node --test tests/marketingCoordinationInput.test.js
// What Coordinations accepts from the app: a request, an approval and its decision, a meeting, a follow-up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanRequestInput, cleanApprovalInput, cleanDecisionInput, cleanMeetingInput, cleanFollowUpInput } from '../utils/marketingCoordinationInput.js';

const ID = '64b7f0c2a1b2c3d4e5f60718';
const refused = (r, field, message) => {
  assert.equal(r.ok, false, `expected a refusal for ${field}`);
  assert.equal(r.field, field);
  if (message) assert.match(r.message, message);
};

test('a request: a title and the team it is for are needed; the rest has defaults', () => {
  const ok = cleanRequestInput({ title: '  Raw footage from the shoot ', toDept: 'Socials' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { title: 'Raw footage from the shoot', kind: 'request', fromDept: 'Marketing', toDept: 'Socials' });
  refused(cleanRequestInput({ toDept: 'Socials' }), 'title', /title/);
  refused(cleanRequestInput({ title: ' x ', toDept: 'Socials' }), 'title');
  refused(cleanRequestInput({ title: 'Ok title' }), 'toDept', /for/);
  refused(cleanRequestInput({ title: 'Ok title', toDept: 'Mars' }), 'toDept');
  refused(cleanRequestInput({ title: 'Ok title', toDept: 'Socials', fromDept: 'Mars' }), 'fromDept');
  assert.equal(cleanRequestInput({ title: 'Ok title', toDept: 'Sales', fromDept: 'Production' }).value.fromDept, 'Production');
});

test('a request: the kind is a request or a handover, set only when it is made', () => {
  assert.equal(cleanRequestInput({ title: 'Hand over', toDept: 'Sales', kind: 'handover' }).value.kind, 'handover');
  refused(cleanRequestInput({ title: 'Hand over', toDept: 'Sales', kind: 'task' }), 'kind');
  const update = cleanRequestInput({ kind: 'handover', priority: 'low' }, { status: 'open' });
  assert.equal(update.ok, true);
  assert.deepEqual(update.value, { priority: 'low' }, 'the kind cannot be changed afterwards');
});

test('a request: priority, due day, progress, brand and text fields are checked and capped', () => {
  const base = { title: 'Ok title', toDept: 'Sales' };
  assert.equal(cleanRequestInput({ ...base, priority: 'high', dueDate: '2026-11-20', progress: 40.6, brand: 'kerala', detail: ' hello ' }).value.progress, 41);
  refused(cleanRequestInput({ ...base, priority: 'urgent' }), 'priority');
  refused(cleanRequestInput({ ...base, dueDate: '2026-02-31' }), 'dueDate');
  refused(cleanRequestInput({ ...base, dueDate: 'tomorrow' }), 'dueDate');
  assert.equal(cleanRequestInput({ ...base, dueDate: '' }).value.dueDate, null, 'an empty day clears it');
  assert.equal(cleanRequestInput({ ...base, dueDate: null }).value.dueDate, null);
  for (const progress of [-1, 101, 'x', '', null, NaN]) refused(cleanRequestInput({ ...base, progress }), 'progress');
  assert.equal(cleanRequestInput({ ...base, progress: '0' }).value.progress, 0);
  refused(cleanRequestInput({ ...base, brand: 'mars' }), 'brand');
  assert.equal(cleanRequestInput({ ...base, detail: 'x'.repeat(3000) }).value.detail.length, 2000);
  assert.equal(cleanRequestInput({ ...base, title: 'y'.repeat(500) }).value.title.length, 200);
  assert.equal(cleanRequestInput({ ...base, assigneeName: ' Jithya ' }).value.assigneeName, 'Jithya');
});

test('a request: people are valid ids or null; anything else is refused', () => {
  const base = { title: 'Ok title', toDept: 'Sales' };
  assert.equal(cleanRequestInput({ ...base, assigneeId: ID }).value.assigneeId, ID);
  assert.equal(cleanRequestInput({ ...base, assigneeId: null }).value.assigneeId, null);
  assert.equal(cleanRequestInput({ ...base, assigneeId: '' }).value.assigneeId, null);
  refused(cleanRequestInput({ ...base, assigneeId: 'not-an-id' }), 'assigneeId');
  refused(cleanRequestInput({ ...base, requestedById: { $gt: '' } }), 'requestedById');
  assert.equal(cleanRequestInput({ ...base, requestedById: ID }).value.requestedById, ID);
});

test('a request: the status must be known; a new one starts open or in progress; a move must follow the machine', () => {
  const base = { title: 'Ok title', toDept: 'Sales' };
  assert.equal(cleanRequestInput({ ...base, status: 'in_progress' }).value.status, 'in_progress');
  assert.equal(cleanRequestInput({ ...base, status: 'open' }).value.status, 'open');
  refused(cleanRequestInput({ ...base, status: 'completed' }), 'status', /starts Open/);
  refused(cleanRequestInput({ ...base, status: 'done' }), 'status', /Unknown/);
  assert.equal(cleanRequestInput({ status: 'in_review' }, { status: 'in_progress' }).value.status, 'in_review');
  refused(cleanRequestInput({ status: 'open' }, { status: 'in_progress' }), 'status', /In Progress cannot be moved to Open/);
  refused(cleanRequestInput({ status: 'in_review' }, { status: 'open' }), 'status', /Open cannot be moved to In Review/);
  assert.equal(cleanRequestInput({ status: 'in_progress' }, { status: 'in_progress' }).value.status, 'in_progress', 'staying put is fine');
  assert.equal(cleanRequestInput({ status: 'in_progress' }, { status: 'completed' }).value.status, 'in_progress', 'reopening');
  assert.equal(cleanRequestInput({ title: 'New title' }, { status: 'completed' }).value.status, undefined, 'status is set only when it was sent');
  refused(cleanRequestInput({ title: '' }, { status: 'open' }), 'title');
});

test('an approval: what, which category, an amount that is zero or more, rounded to paise', () => {
  const ok = cleanApprovalInput({ title: ' Campaign ad budget – Nov ', category: 'Marketing', amount: '20000.456', impact: ' Reach +20% ', dueDate: '2026-11-20' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { title: 'Campaign ad budget – Nov', category: 'Marketing', amount: 20000.46, impact: 'Reach +20%', dueDate: '2026-11-20' });
  refused(cleanApprovalInput({ category: 'Marketing' }), 'title', /needs approving/);
  refused(cleanApprovalInput({ title: 'Ok title' }), 'category');
  refused(cleanApprovalInput({ title: 'Ok title', category: 'Nowhere' }), 'category');
  assert.equal(cleanApprovalInput({ title: 'Ok title', category: 'Brand' }).ok, true, 'Brand is a category');
  for (const amount of [-1, 'lots', 2_000_000_000, Infinity]) refused(cleanApprovalInput({ title: 'Ok title', category: 'HR', amount }), 'amount');
  assert.equal(cleanApprovalInput({ title: 'Ok title', category: 'HR', amount: '' }).value.amount, 0);
  assert.equal(cleanApprovalInput({ title: 'Ok title', category: 'HR', amount: 0 }).value.amount, 0);
  refused(cleanApprovalInput({ title: 'Ok title', category: 'HR', dueDate: '31/10/2026' }), 'dueDate');
  assert.equal(cleanApprovalInput({ title: 'Ok title', category: 'HR', dueDate: null }).value.dueDate, null);
  assert.equal(cleanApprovalInput({ title: 'Ok title', category: 'HR', impact: 'x'.repeat(900) }).value.impact.length, 500);
  refused(cleanApprovalInput({ title: 'Ok title', category: 'HR', requestId: 'nope' }), 'requestId');
  assert.equal(cleanApprovalInput({ title: 'Ok title', category: 'HR', requestId: ID }).value.requestId, ID);
  assert.equal(cleanApprovalInput({ title: 'Ok title', category: 'HR', requestId: null }).value.requestId, null);
  refused(cleanApprovalInput({ title: 'Ok title', category: 'HR', brand: 'x' }), 'brand');
});

test('an approval update changes only what was sent', () => {
  const u = cleanApprovalInput({ amount: 500 }, { status: 'pending' });
  assert.deepEqual(u.value, { amount: 500 });
  refused(cleanApprovalInput({ title: '' }, { status: 'pending' }), 'title');
});

test('a decision: approve, reject (with a reason), escalate or review; the note is capped', () => {
  assert.deepEqual(cleanDecisionInput({ decision: 'approve' }).value, { decision: 'approve', note: '' });
  assert.deepEqual(cleanDecisionInput({ decision: 'approve', note: ' Go ahead ' }).value, { decision: 'approve', note: 'Go ahead' });
  assert.deepEqual(cleanDecisionInput({ decision: 'escalate' }).value, { decision: 'escalate', note: '' });
  assert.equal(cleanDecisionInput({ decision: 'review' }).ok, true);
  refused(cleanDecisionInput({ decision: 'reject' }), 'note', /why it is rejected/);
  refused(cleanDecisionInput({ decision: 'reject', note: '  ' }), 'note');
  refused(cleanDecisionInput({ decision: 'reject', note: 'no' }), 'note');
  assert.equal(cleanDecisionInput({ decision: 'reject', note: 'Over budget' }).ok, true);
  refused(cleanDecisionInput({ decision: 'delete' }), 'decision');
  refused(cleanDecisionInput({}), 'decision');
  refused(cleanDecisionInput(), 'decision');
  assert.equal(cleanDecisionInput({ decision: 'approve', note: 'x'.repeat(2000) }).value.note.length, 1000);
});

const M = { title: 'Marketing Sync', startAt: '2026-11-13T05:30:00Z', endAt: '2026-11-13T06:30:00Z' };

test('a meeting: a title and start and end instants; it has to end after it starts and last at most a day', () => {
  const ok = cleanMeetingInput(M);
  assert.equal(ok.ok, true);
  assert.equal(ok.value.startAt.toISOString(), '2026-11-13T05:30:00.000Z');
  refused(cleanMeetingInput({ ...M, title: '' }), 'title');
  refused(cleanMeetingInput({ ...M, startAt: undefined }), 'startAt');
  refused(cleanMeetingInput({ ...M, startAt: 'tomorrow' }), 'startAt');
  refused(cleanMeetingInput({ ...M, endAt: '2026-11-13' }), 'endAt');
  refused(cleanMeetingInput({ ...M, endAt: '2026-11-13T05:30:00Z' }), 'endAt', /end after/);
  refused(cleanMeetingInput({ ...M, endAt: '2026-11-13T05:00:00Z' }), 'endAt');
  refused(cleanMeetingInput({ ...M, endAt: '2026-11-14T06:00:00Z' }), 'endAt', /24 hours/);
  assert.equal(cleanMeetingInput({ ...M, endAt: '2026-11-14T05:30:00Z' }).ok, true, 'exactly 24 hours is fine');
});

test('a meeting update is checked against the times it already has', () => {
  const existing = { startAt: new Date('2026-11-13T05:30:00Z'), endAt: new Date('2026-11-13T06:30:00Z'), status: 'upcoming' };
  assert.equal(cleanMeetingInput({ notes: 'Discussed the plan' }, existing).ok, true);
  refused(cleanMeetingInput({ startAt: '2026-11-13T07:00:00Z' }, existing), 'endAt', /end after/);
  assert.equal(cleanMeetingInput({ startAt: '2026-11-13T06:00:00Z' }, existing).ok, true);
  refused(cleanMeetingInput({ title: ' ' }, existing), 'title');
});

test('a meeting: link must be http(s); location, status, notes, departments', () => {
  assert.equal(cleanMeetingInput({ ...M, link: 'https://meet.google.com/abc-defg' }).value.link, 'https://meet.google.com/abc-defg');
  refused(cleanMeetingInput({ ...M, link: 'javascript:alert(1)' }), 'link', /https/);
  refused(cleanMeetingInput({ ...M, link: 'meet.google.com/abc' }), 'link');
  assert.equal(cleanMeetingInput({ ...M, link: '' }).value.link, '', 'an empty link clears it');
  assert.equal(cleanMeetingInput({ ...M, location: 'x'.repeat(400) }).value.location.length, 160);
  assert.equal(cleanMeetingInput({ ...M, status: 'completed' }).value.status, 'completed');
  refused(cleanMeetingInput({ ...M, status: 'done' }), 'status');
  assert.equal(cleanMeetingInput({ ...M, notes: 'y'.repeat(9000) }).value.notes.length, 4000);
  assert.deepEqual(cleanMeetingInput({ ...M, departments: ['Sales', 'Sales', 'IT'] }).value.departments, ['Sales', 'IT']);
  refused(cleanMeetingInput({ ...M, departments: ['Mars'] }), 'departments');
  refused(cleanMeetingInput({ ...M, departments: 'Sales' }), 'departments');
  refused(cleanMeetingInput({ ...M, brand: 'x' }), 'brand');
});

test('a meeting: agenda and attendees are lists, trimmed, de-duplicated and capped', () => {
  assert.deepEqual(cleanMeetingInput({ ...M, agenda: [' Campaign review ', '', 'Pipeline'] }).value.agenda, ['Campaign review', 'Pipeline']);
  refused(cleanMeetingInput({ ...M, agenda: 'one point' }), 'agenda');
  refused(cleanMeetingInput({ ...M, agenda: Array.from({ length: 21 }, (_, i) => `p${i}`) }), 'agenda');
  const a = cleanMeetingInput({ ...M, attendees: [{ memberId: ID }, { memberId: ID }, { name: ' Client ' }, { name: 'client' }, { name: '' }, {}] }).value.attendees;
  assert.deepEqual(a, [{ memberId: ID, name: '' }, { memberId: null, name: 'Client' }]);
  refused(cleanMeetingInput({ ...M, attendees: [{ memberId: 'nope' }] }), 'attendees');
  refused(cleanMeetingInput({ ...M, attendees: {} }), 'attendees');
  refused(cleanMeetingInput({ ...M, attendees: Array.from({ length: 41 }, (_, i) => ({ name: `n${i}` })) }), 'attendees');
});

test('a meeting: action items need words and a real due day', () => {
  const items = cleanMeetingInput({ ...M, actionItems: [{ text: ' Send the plan ', ownerId: ID, due: '2026-11-20' }, { text: 'Book the studio', ownerName: ' Faris ', done: true }] }).value.actionItems;
  assert.deepEqual(items, [
    { id: null, text: 'Send the plan', ownerId: ID, ownerName: '', due: '2026-11-20', done: false },
    { id: null, text: 'Book the studio', ownerId: null, ownerName: 'Faris', due: null, done: true },
  ]);
  assert.equal(cleanMeetingInput({ ...M, actionItems: [{ id: ID, text: 'Keep me' }] }).value.actionItems[0].id, ID);
  assert.equal(cleanMeetingInput({ ...M, actionItems: [{ id: 'junk', text: 'Keep me' }] }).value.actionItems[0].id, null);
  refused(cleanMeetingInput({ ...M, actionItems: [{ text: '' }] }), 'actionItems');
  refused(cleanMeetingInput({ ...M, actionItems: [{ text: 'Do it', due: '2026-13-01' }] }), 'actionItems');
  refused(cleanMeetingInput({ ...M, actionItems: [{ text: 'Do it', ownerId: 'nope' }] }), 'actionItems');
  refused(cleanMeetingInput({ ...M, actionItems: 'x' }), 'actionItems');
  refused(cleanMeetingInput({ ...M, actionItems: Array.from({ length: 31 }, () => ({ text: 'do it' })) }), 'actionItems');
  assert.deepEqual(cleanMeetingInput({ ...M, actionItems: [] }).value.actionItems, []);
});

test('a follow-up: what and when are needed; the department defaults to Marketing; the owner is an id or null', () => {
  const ok = cleanFollowUpInput({ item: ' Get final content approval ', dueDate: '2026-11-13', relatedTo: ' Bridal Campaign ', reminder: true, ownerId: ID });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { item: 'Get final content approval', relatedTo: 'Bridal Campaign', department: 'Marketing', dueDate: '2026-11-13', reminder: true, ownerId: ID });
  refused(cleanFollowUpInput({ dueDate: '2026-11-13' }), 'item', /following up/);
  refused(cleanFollowUpInput({ item: 'Ok item' }), 'dueDate', /due/);
  refused(cleanFollowUpInput({ item: 'Ok item', dueDate: '2026-02-30' }), 'dueDate');
  refused(cleanFollowUpInput({ item: 'Ok item', dueDate: '2026-11-13', department: 'Mars' }), 'department');
  refused(cleanFollowUpInput({ item: 'Ok item', dueDate: '2026-11-13', ownerId: 'nope' }), 'ownerId');
  assert.equal(cleanFollowUpInput({ item: 'Ok item', dueDate: '2026-11-13', ownerId: null }).value.ownerId, null);
  assert.equal(cleanFollowUpInput({ item: 'Ok item', dueDate: '2026-11-13', reminder: 'yes' }).value.reminder, false, 'only true turns it on');
  assert.equal(cleanFollowUpInput({ item: 'Ok item', dueDate: '2026-11-13', department: 'HR' }).value.department, 'HR');
});

test('a follow-up: status, meeting link and brand', () => {
  assert.equal(cleanFollowUpInput({ status: 'done' }, { status: 'open' }).value.status, 'done');
  refused(cleanFollowUpInput({ status: 'overdue' }, { status: 'open' }), 'status', /Open or Done/);
  assert.equal(cleanFollowUpInput({ item: 'Ok item', dueDate: '2026-11-13', meetingId: ID }).value.meetingId, ID);
  assert.equal(cleanFollowUpInput({ item: 'Ok item', dueDate: '2026-11-13', meetingId: null }).value.meetingId, null);
  refused(cleanFollowUpInput({ item: 'Ok item', dueDate: '2026-11-13', meetingId: 'nope' }), 'meetingId');
  refused(cleanFollowUpInput({ item: 'Ok item', dueDate: '2026-11-13', brand: 'x' }), 'brand');
  assert.equal(cleanFollowUpInput({ item: 'Ok item', dueDate: '2026-11-13', item2: 'x' }).ok, true, 'unknown fields are ignored');
  assert.deepEqual(cleanFollowUpInput({ ownerName: ' Someone ' }, { status: 'open' }).value, { ownerName: 'Someone' });
  assert.equal(Object.keys(cleanFollowUpInput({ item: 'Ok item', dueDate: '2026-11-13', createdBy: 'x', doneAt: 'x', _id: 'x' }).value).includes('createdBy'), false, 'server fields are never taken from the client');
});
