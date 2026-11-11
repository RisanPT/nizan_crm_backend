// node --test tests/taskPermissions.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { structureChanges, editModeOf, PROGRESS_FIELDS } from '../utils/taskPermissions.js';

const stored = {
  _id: 't1', projectId: 'p1', title: 'Design poster', description: 'x', assignedTo: 'e1', departmentName: 'Marketing',
  status: 'todo', percentComplete: 0, startDate: new Date('2026-11-01T00:00:00Z'), deadline: new Date('2026-11-10T00:00:00Z'),
  predecessorIds: ['a', 'b'], estimatedHours: 8, actualHours: 0, subtasks: [], priority: 'medium',
};

test('how it is going is never a structure change', () => {
  assert.deepEqual(structureChanges(stored, { status: 'in-progress', percentComplete: 40, actualHours: 3, subtasks: [{ title: 'x' }], activityLogs: [] }), []);
  for (const f of PROGRESS_FIELDS) assert.deepEqual(structureChanges(stored, { [f]: 'whatever' }), [], f);
});

test('a form that sends the whole task back unchanged changes nothing', () => {
  const echoed = {
    ...stored,
    projectId: { _id: 'p1', name: 'Poster' }, // populated reference
    assignedTo: { _id: 'e1', name: 'Anu' },
    startDate: '2026-11-01T00:00:00.000Z', // the same instant, as text
    deadline: '2026-11-10T00:00:00.000Z',
    predecessorIds: [{ _id: 'a' }, { _id: 'b' }],
    status: 'in-progress',
    percentComplete: 30,
    createdAt: '2026-10-01', updatedAt: '2026-10-02', __v: 3,
  };
  assert.deepEqual(structureChanges(stored, echoed), []);
});

test('a real change to the plan is reported by name', () => {
  assert.deepEqual(structureChanges(stored, { title: 'Design poster v2' }), ['title']);
  assert.deepEqual(structureChanges(stored, { deadline: '2026-11-12T00:00:00.000Z' }), ['deadline']);
  assert.deepEqual(structureChanges(stored, { assignedTo: 'e2', departmentName: 'HR' }).sort(), ['assignedTo', 'departmentName']);
  assert.deepEqual(structureChanges(stored, { predecessorIds: ['a'] }), ['predecessorIds']);
  assert.deepEqual(structureChanges(stored, { estimatedHours: 20, priority: 'high' }).sort(), ['estimatedHours', 'priority']);
});

test('clearing a field counts; setting an unset field counts', () => {
  assert.deepEqual(structureChanges(stored, { assignedTo: null }), ['assignedTo']);
  assert.deepEqual(structureChanges({ ...stored, parentTaskId: null }, { parentTaskId: 'p' }), ['parentTaskId']);
  assert.deepEqual(structureChanges({ ...stored, parentTaskId: null }, { parentTaskId: null }), []);
});

test('works with a Mongoose-style document (toObject)', () => {
  const doc = { toObject: () => ({ ...stored }) };
  assert.deepEqual(structureChanges(doc, { title: 'Design poster' }), []);
  assert.deepEqual(structureChanges(doc, { title: 'Other' }), ['title']);
});

test('edit mode: only an explicit "managed" is managed — a project saved before the setting is open', () => {
  assert.equal(editModeOf({ editMode: 'managed' }), 'managed');
  assert.equal(editModeOf({ editMode: 'open' }), 'open');
  assert.equal(editModeOf({}), 'open');
  assert.equal(editModeOf(null), 'open');
});
