// node --test tests/projectProgress.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { projectProgress, departmentProgress, leafTasks } from '../utils/projectProgress.js';

const t = (id, percentComplete, extra = {}) => ({ _id: id, percentComplete, parentTaskId: null, ...extra });

test('average of the LEAF tasks; a phase row with children is not counted', () => {
  const tasks = [
    t('phase1', 0), // a phase: has children
    t('a', 100, { parentTaskId: 'phase1' }),
    t('b', 50, { parentTaskId: 'phase1' }),
    t('c', 0),
  ];
  assert.deepEqual(leafTasks(tasks).map((x) => x._id), ['a', 'b', 'c']);
  assert.equal(projectProgress(tasks), 50); // (100 + 50 + 0) / 3
});

test('rounds, clamps, and an empty project is 0', () => {
  assert.equal(projectProgress([t('a', 33), t('b', 33), t('c', 34)]), 33);
  assert.equal(projectProgress([t('a', 150), t('b', -20)]), 50); // 100 and 0
  assert.equal(projectProgress([t('a', undefined)]), 0);
  assert.equal(projectProgress([]), 0);
  assert.equal(projectProgress(), 0);
});

test('nested phases: only the deepest tasks count', () => {
  const tasks = [t('p', 0), t('sp', 0, { parentTaskId: 'p' }), t('x', 100, { parentTaskId: 'sp' }), t('y', 0, { parentTaskId: 'sp' })];
  assert.equal(projectProgress(tasks), 50);
});

test('works with ObjectId-like values (toString) as ids', () => {
  const oid = (s) => ({ toString: () => s });
  assert.equal(projectProgress([t(oid('p'), 0), t(oid('a'), 80, { parentTaskId: oid('p') })]), 80);
});

test('a task with closed or deployed status counts as 100% even if percentComplete is 0', () => {
  const tasks = [
    t('a', 0, { status: 'closed' }),
    t('b', 0, { status: 'deployed' }),
    t('c', 0, { status: 'todo' }),
  ];
  assert.equal(projectProgress(tasks), 67); // (100 + 100 + 0) / 3 = 66.666 -> 67
});

test('per-department progress: each department averages its OWN leaf tasks; untagged tasks belong to the owner', () => {
  const tasks = [
    t('a', 100, { departmentName: 'Marketing' }),
    t('b', 50, { departmentName: 'marketing' }), // case does not matter
    t('c', 20, { departmentName: 'HR' }),
    t('d', 40), // no department → the owner (IT)
    t('phase', 0),
    t('e', 60, { parentTaskId: 'phase', departmentName: 'IT' }),
  ];
  const dp = departmentProgress(tasks, ['IT', 'Marketing', 'HR', 'Finance'], 'IT');
  assert.deepEqual(dp.map((d) => [d.name, d.progress, d.tasks, d.done]), [
    ['IT', 50, 2, 0], // d (40) and e (60)
    ['Marketing', 75, 2, 1],
    ['HR', 20, 1, 0],
    ['Finance', 0, 0, 0], // invited but nothing yet
  ]);
});
