// Pure unit tests: node --test tests/marketingActivityInput.test.js
// What a log and a task may contain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanActivityInput, cleanTaskInput, cleanAttachments, isDay } from '../utils/marketingActivityInput.js';

const TODAY = '2026-11-12';
const ID = '64b2f0c1a1b2c3d4e5f60718';
const ok = (body) => cleanActivityInput({ workedOn: 'Edited the bridal reel', ...body }, { today: TODAY });

test('a minimal log is valid and gets sensible defaults', () => {
  const r = ok({});
  assert.equal(r.ok, true);
  assert.deepEqual([r.value.entryDate, r.value.brand, r.value.kind, r.value.status, r.value.timeSpentMinutes], [TODAY, 'main', 'task', 'completed', 0]);
});

test('what was worked on is required (and not just a letter)', () => {
  for (const workedOn of ['', ' ', 'a', undefined]) assert.equal(cleanActivityInput({ workedOn }, { today: TODAY }).field, 'workedOn');
});

test('the date: YYYY-MM-DD, real, and not in the future', () => {
  assert.equal(ok({ entryDate: '2026-11-13' }).field, 'entryDate');
  assert.equal(ok({ entryDate: '12/11/2026' }).field, 'entryDate');
  assert.equal(ok({ entryDate: '2026-02-31' }).field, 'entryDate');
  assert.equal(ok({ entryDate: '2026-11-10' }).ok, true);
  assert.equal(isDay('2026-11-12'), true);
  assert.equal(isDay(20261112), false);
});

test('brand, kind and status must be known', () => {
  assert.equal(ok({ brand: 'kerala' }).value.brand, 'kerala');
  assert.equal(ok({ brand: 'KERALA' }).value.brand, 'kerala');
  assert.equal(ok({ brand: 'delhi' }).field, 'brand');
  assert.equal(ok({ kind: 'dance' }).field, 'kind');
  assert.equal(ok({ status: 'done-ish' }).field, 'status');
});

test('time spent: 0 to 24 hours, in whole minutes; text numbers are read', () => {
  assert.equal(ok({ timeSpentMinutes: 465 }).value.timeSpentMinutes, 465);
  assert.equal(ok({ timeSpentMinutes: '90' }).value.timeSpentMinutes, 90);
  assert.equal(ok({ timeSpentMinutes: 12.6 }).value.timeSpentMinutes, 13);
  for (const bad of [-1, 1441, 'a lot', NaN, true]) assert.equal(ok({ timeSpentMinutes: bad }).field, 'timeSpentMinutes', String(bad));
});

test('counts: known activities, no negatives, zeros dropped, none twice; details kept', () => {
  const r = ok({ values: [{ metricId: ID, value: 3, details: 'reel 1, 2, 3' }, { metricId: '64b2f0c1a1b2c3d4e5f60719', value: 0 }] });
  assert.deepEqual(r.value.values, [{ metricId: ID, value: 3, details: 'reel 1, 2, 3' }]);
  assert.equal(ok({ values: [{ metricId: ID, value: -1 }] }).field, 'values');
  assert.equal(ok({ values: [{ metricId: 'nope', value: 1 }] }).field, 'values');
  assert.equal(ok({ values: [{ metricId: ID, value: 1 }, { metricId: ID, value: 2 }] }).field, 'values');
  assert.equal(ok({ values: 'three' }).field, 'values');
  assert.equal(ok({ values: [{ metricId: ID, value: '4' }] }).value.values[0].value, 4);
});

test('attachments are links: http(s) only, at most ten', () => {
  assert.equal(cleanAttachments([{ label: 'Final cut', url: 'https://drive.google.com/x' }]).ok, true);
  assert.equal(cleanAttachments(['http://example.com/a']).value[0].url, 'http://example.com/a');
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', '/local/path', 'ftp://x', '']) assert.equal(cleanAttachments([bad]).ok, false, bad);
  assert.equal(cleanAttachments(Array.from({ length: 11 }, (_, i) => `https://x.com/${i}`)).ok, false);
  assert.equal(cleanAttachments('https://x.com').ok, false);
  assert.deepEqual(cleanAttachments(null), { ok: true, value: [] });
});

test('links to other records must be real ids; a bad one is dropped, not stored', () => {
  const r = ok({ taskId: ID, projectId: 'garbage', shootId: '' });
  assert.equal(r.value.taskId, ID);
  assert.equal(r.value.projectId, null);
  assert.equal(r.value.shootId, null);
});

test('task progress on a log is 0 to 100', () => {
  assert.equal(ok({ taskProgress: 80 }).value.taskProgress, 80);
  assert.equal(ok({}).value.taskProgress, null);
  assert.equal(ok({ taskProgress: 120 }).field, 'taskProgress');
});

test('a long text is cut, not refused', () => {
  const r = ok({ workedOn: 'x'.repeat(500), comment: 'y'.repeat(3000) });
  assert.equal(r.value.workedOn.length, 300);
  assert.equal(r.value.comment.length, 1000);
});

// ── tasks ────────────────────────────────────────────────────────────────────

test('a task needs a title; brand, priority, status and due date must be valid', () => {
  assert.equal(cleanTaskInput({ title: '' }).field, 'title');
  assert.equal(cleanTaskInput({ title: 'Studio tour reel', brand: 'x' }).field, 'brand');
  assert.equal(cleanTaskInput({ title: 'Studio tour reel', priority: 'urgent' }).field, 'priority');
  assert.equal(cleanTaskInput({ title: 'Studio tour reel', status: 'later' }).field, 'status');
  assert.equal(cleanTaskInput({ title: 'Studio tour reel', dueDate: '10 Nov' }).field, 'dueDate');
  const r = cleanTaskInput({ title: 'Studio tour reel', dueDate: '2026-11-10', priority: 'high' });
  assert.equal(r.ok, true);
  assert.deepEqual([r.value.priority, r.value.status, r.value.progress, r.value.brand], ['high', 'not_started', 0, 'main']);
});

test('progress and status tell the same story: 100% is completed, completed is 100%, progress starts a task', () => {
  assert.deepEqual((({ status, progress }) => [status, progress])(cleanTaskInput({ title: 'Edit', status: 'completed', progress: 40 }).value), ['completed', 100]);
  assert.deepEqual((({ status, progress }) => [status, progress])(cleanTaskInput({ title: 'Edit', progress: 100 }).value), ['completed', 100]);
  assert.deepEqual((({ status, progress }) => [status, progress])(cleanTaskInput({ title: 'Edit', progress: 30 }).value), ['in_progress', 30]);
  assert.equal(cleanTaskInput({ title: 'Edit', progress: 101 }).field, 'progress');
  assert.equal(cleanTaskInput({ title: 'Edit', progress: -1 }).field, 'progress');
});

test('an edit keeps what was not sent', () => {
  const existing = { title: 'Edit the reel', priority: 'high', dueDate: '2026-11-10', status: 'in_progress', progress: 40, brand: 'kerala', isDeliverable: true };
  const r = cleanTaskInput({ progress: 60 }, existing);
  assert.deepEqual([r.value.title, r.value.priority, r.value.dueDate, r.value.brand, r.value.progress, r.value.isDeliverable], ['Edit the reel', 'high', '2026-11-10', 'kerala', 60, true]);
  assert.equal(cleanTaskInput({ dueDate: null }, existing).value.dueDate, null, 'a due date can be cleared');
});

test('a log can name the development project and the Socials post it was for (real ids only)', () => {
  const v = ok({ devProjectId: ID, contentId: ID }).value;
  assert.deepEqual([v.devProjectId, v.contentId], [ID, ID]);
  const bad = ok({ devProjectId: 'not-an-id', contentId: '' }).value;
  assert.deepEqual([bad.devProjectId, bad.contentId], [null, null]);
});
