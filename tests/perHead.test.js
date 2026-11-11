// Pure unit tests: node --test tests/perHead.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { perHead } from '../utils/perHead.js';

const lead = { employeeId: 'anu', name: 'Anu', roleType: 'lead' };
const asst = { employeeId: 'fathima', name: 'Fathima', roleType: 'assistant' };
const asst2 = { employeeId: 'meera', name: 'Meera', roleType: 'assistant' };
const food = (employeeId, amount, name) => ({ employeeId, amount, name });

test('food ÷ heads, with what each person spent', () => {
  const r = perHead({ people: [lead, asst], lines: [food('anu', 200), food('anu', 30), food('fathima', 230)] });
  assert.equal(r.heads, 2);
  assert.equal(r.foodPerHead, 230);
  assert.deepEqual(r.people.map((p) => [p.name, p.roleType, p.food, p.assigned]), [['Anu', 'lead', 230, true], ['Fathima', 'assistant', 230, true]]);
});

test('someone on the work who filed no food is still a head, at ₹0 — the per-head cost shows it', () => {
  const r = perHead({ people: [lead, asst, asst2], lines: [food('anu', 450)] });
  assert.equal(r.heads, 3);
  assert.equal(r.foodPerHead, 150);
  assert.deepEqual(r.people.map((p) => [p.name, p.food]), [['Anu', 450], ['Fathima', 0], ['Meera', 0]]);
});

test('one head: the whole food bill is the per-head cost', () => {
  const r = perHead({ people: [lead], lines: [food('anu', 99.5)] });
  assert.deepEqual([r.heads, r.foodPerHead], [1, 99.5]);
});

test('paise are exact: ₹100 over 3 heads is 33.33 each (rounded to the paisa)', () => {
  assert.equal(perHead({ people: [lead, asst, asst2], lines: [food('anu', 100)] }).foodPerHead, 33.33);
  assert.equal(perHead({ people: [lead, asst], lines: [food('anu', 0.01)] }).foodPerHead, 0.01);
  assert.equal(perHead({ people: [lead, asst], lines: [food('anu', 99.99), food('anu', 0.02)] }).foodPerHead, 50.01);
});

test('someone who spent on the work without being assigned is listed, but is not a head', () => {
  const r = perHead({ people: [lead], lines: [food('anu', 100), food('ravi', 60, 'Ravi')] });
  assert.equal(r.heads, 1);
  assert.equal(r.foodPerHead, 160, 'all the work\'s food, over the assigned heads');
  assert.deepEqual(r.people.map((p) => [p.name, p.food, p.assigned, p.roleType]), [['Anu', 100, true, 'lead'], ['Ravi', 60, false, '']]);
});

test('nobody assigned: no per-head figure (not a division by zero)', () => {
  const r = perHead({ people: [], lines: [food('x', 50, 'X')] });
  assert.equal(r.heads, 0);
  assert.equal(r.foodPerHead, null);
  assert.equal(r.people.length, 1);
});

test('no food at all', () => {
  const r = perHead({ people: [lead, asst], lines: [] });
  assert.deepEqual([r.heads, r.foodPerHead], [2, 0]);
  assert.deepEqual(r.people.map((p) => p.food), [0, 0]);
  assert.deepEqual(perHead({}), { heads: 0, foodPerHead: null, people: [] });
});

test('a name missing from the assignment is taken from the expense', () => {
  const r = perHead({ people: [{ employeeId: 'anu', roleType: 'lead' }], lines: [food('anu', 10, 'Anu from the bill')] });
  assert.equal(r.people[0].name, 'Anu from the bill');
});

test('an unknown role is treated as an assistant; only "lead" is a lead', () => {
  const r = perHead({ people: [{ employeeId: 'a', name: 'A', roleType: 'something' }], lines: [] });
  assert.equal(r.people[0].roleType, 'assistant');
});
