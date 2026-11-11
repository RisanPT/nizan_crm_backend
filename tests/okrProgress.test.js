// node --test tests/okrProgress.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { krAttainment, objectiveProgress } from '../utils/okrProgress.js';

const kr = (currentValue, targetValue, extra = {}) => ({ currentValue, targetValue, ...extra });

test('a key result: current ÷ target, capped at 100; done is 100', () => {
  assert.equal(krAttainment(kr(25, 100)), 25);
  assert.equal(krAttainment(kr(150, 100)), 100);
  assert.equal(krAttainment(kr(10, 100, { completed: true })), 100);
  assert.equal(krAttainment(kr(-5, 100)), 0);
});

test('bad targets never produce NaN or Infinity', () => {
  assert.equal(krAttainment(kr(5, 0)), 0);
  assert.equal(krAttainment(kr(5, -10)), 0);
  assert.equal(krAttainment(kr(undefined, 100)), 0);
  assert.equal(krAttainment({}), 0);
  assert.equal(krAttainment(undefined), 0);
});

test('an objective with key results IS their average — a typed number no longer wins', () => {
  assert.equal(objectiveProgress([kr(10, 100), kr(10, 100)], 100), 10, 'was able to say 100% with every KR at 10%');
  assert.equal(objectiveProgress([kr(100, 100), kr(0, 100), kr(50, 100)], 0), 50);
  assert.equal(objectiveProgress([kr(1, 3)], 0), 33);
});

test('with no key results it stays the manual figure, clamped', () => {
  assert.equal(objectiveProgress([], 40), 40);
  assert.equal(objectiveProgress(undefined, 250), 100);
  assert.equal(objectiveProgress(null, -3), 0);
  assert.equal(objectiveProgress([], 'abc'), 0);
});
