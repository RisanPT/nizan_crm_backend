// Pure unit tests: node --test tests/foodAllowance.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRule, ruleFor, compareFood, rangesOverlap, teamMealCheck, mealPools, poolPerHead, poolKey } from '../utils/foodAllowance.js';

const rule = (meal, amountPerHead, extra = {}) => ({ meal, amountPerHead, effectiveFrom: '', effectiveTo: '', active: true, ...extra });
const RULES = [rule('breakfast', 100), rule('lunch', 150), rule('snacks', 50), rule('dinner', 150)];
const f = (meal, amount) => ({ meal, amount });

test('lunch for 2 heads at ₹150: allowed ₹300; ₹330 is over by ₹30', () => {
  const r = compareFood({ rules: RULES, dayKey: '2026-10-30', heads: 2, lines: [f('lunch', 200), f('lunch', 130)] });
  assert.deepEqual(r.meals, [{ meal: 'lunch', meals: ['lunch'], actual: 330, allowancePerHead: 150, allowed: 300, over: 30, status: 'over' }]);
  assert.deepEqual([r.allowed, r.actual, r.over, r.hasOver], [300, 330, 30, true]);
});

test('within the allowance: nothing is over, and being under is not a problem', () => {
  const r = compareFood({ rules: RULES, dayKey: '2026-10-30', heads: 3, lines: [f('breakfast', 200), f('lunch', 450)] });
  assert.deepEqual(r.meals.map((m) => [m.meal, m.allowed, m.over, m.status]), [['breakfast', 300, 0, 'within'], ['lunch', 450, 0, 'within']]);
  assert.equal(r.hasOver, false);
});

test('only the meals that were eaten are checked — a work with no dinner is not "under" on dinner', () => {
  const r = compareFood({ rules: RULES, dayKey: '2026-10-30', heads: 2, lines: [f('lunch', 100)] });
  assert.deepEqual(r.meals.map((m) => m.meal), ['lunch']);
  assert.equal(r.allowed, 300);
});

test('meal by meal: an overspend on lunch is not cancelled out by an underspend on snacks', () => {
  const r = compareFood({ rules: RULES, dayKey: '2026-10-30', heads: 2, lines: [f('lunch', 400), f('snacks', 10)] });
  assert.deepEqual([r.allowed, r.actual, r.over], [400, 410, 100]);
  assert.deepEqual(r.meals.map((m) => m.status), ['over', 'within']);
});

test('a meal with no allowance set is shown but not checked', () => {
  const r = compareFood({ rules: [rule('lunch', 150)], dayKey: '2026-10-30', heads: 2, lines: [f('dinner', 999), f('lunch', 100)] });
  assert.deepEqual(r.meals.map((m) => [m.meal, m.status, m.allowed]), [['lunch', 'within', 300], ['dinner', 'no_rule', null]]);
  assert.deepEqual([r.allowed, r.actual, r.over], [300, 100, 0], 'the unchecked meal is not in the totals');
});

test('nobody assigned: not checked (never a divide / multiply by zero)', () => {
  const r = compareFood({ rules: RULES, dayKey: '2026-10-30', heads: 0, lines: [f('lunch', 100)] });
  assert.deepEqual([r.meals[0].status, r.meals[0].allowed, r.hasOver], ['no_heads', null, false]);
});

test('food with no meal recorded is reported but cannot be checked', () => {
  const r = compareFood({ rules: RULES, dayKey: '2026-10-30', heads: 2, lines: [f('', 80), { amount: 20 }, f('lunch', 100)] });
  assert.equal(r.noMeal, 100);
  assert.deepEqual(r.meals.map((m) => m.meal), ['lunch']);
});

test('paise are exact', () => {
  const r = compareFood({ rules: [rule('lunch', 33.33)], dayKey: '2026-10-30', heads: 3, lines: [f('lunch', 100)] });
  assert.deepEqual([r.allowed, r.over], [99.99, 0.01]);
  assert.equal(compareFood({ rules: [rule('lunch', 0)], dayKey: 'd', heads: 2, lines: [f('lunch', 1)] }).over, 1, 'a ₹0 allowance means any spend is over');
});

test('which rule applies: the one for the work\'s day; an inactive one never', () => {
  const rules = [
    rule('lunch', 120, { effectiveTo: '2026-09-30' }),
    rule('lunch', 150, { effectiveFrom: '2026-10-01' }),
    rule('lunch', 999, { active: false }),
  ];
  assert.equal(ruleFor(rules, 'lunch', '2026-09-30').amountPerHead, 120);
  assert.equal(ruleFor(rules, 'lunch', '2026-10-01').amountPerHead, 150);
  assert.equal(ruleFor(rules, 'lunch', '2027-05-05').amountPerHead, 150, 'open-ended');
  assert.equal(ruleFor(rules, 'dinner', '2026-10-01'), null);
  assert.equal(ruleFor([], 'lunch', '2026-10-01'), null);
});

test('when two rules cover the day, the one that started later wins', () => {
  const rules = [rule('lunch', 100), rule('lunch', 180, { effectiveFrom: '2026-10-01' })];
  assert.equal(ruleFor(rules, 'lunch', '2026-10-15').amountPerHead, 180);
  assert.equal(ruleFor(rules, 'lunch', '2026-09-15').amountPerHead, 100);
});

test('date ranges: open sides, touching and disjoint', () => {
  assert.equal(rangesOverlap({}, {}), true);
  assert.equal(rangesOverlap({ effectiveTo: '2026-09-30' }, { effectiveFrom: '2026-10-01' }), false);
  assert.equal(rangesOverlap({ effectiveTo: '2026-10-01' }, { effectiveFrom: '2026-10-01' }), true, 'they share 1 Oct');
  assert.equal(rangesOverlap({ effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31' }, { effectiveFrom: '2026-06-01', effectiveTo: '2026-06-30' }), true);
});

test('validateRule: a good rule is cleaned', () => {
  const r = validateRule({ meal: 'lunch', amountPerHead: ' 150.456 ', effectiveFrom: '2026-10-01', effectiveTo: '', note: '  festival  ', active: 'true' });
  assert.deepEqual(r.clean, { meal: 'lunch', amountPerHead: 150.46, effectiveFrom: '2026-10-01', effectiveTo: '', active: true, note: 'festival' });
  assert.equal(validateRule({ meal: 'dinner', amountPerHead: 0 }).clean.amountPerHead, 0);
  assert.equal(validateRule({ meal: 'dinner', amountPerHead: 1 }).clean.active, true, 'on unless said otherwise');
});

test('validateRule: what is refused, with a message a person can act on', () => {
  const err = (input, existing) => validateRule(input, existing).error;
  assert.match(err({ meal: 'brunch', amountPerHead: 10 }), /Choose a meal/);
  assert.match(err({ meal: 'lunch' }), /Enter the amount/);
  assert.match(err({ meal: 'lunch', amountPerHead: '' }), /Enter the amount/);
  assert.match(err({ meal: 'lunch', amountPerHead: -5 }), /Enter the amount/);
  assert.match(err({ meal: 'lunch', amountPerHead: 'abc' }), /Enter the amount/);
  assert.match(err({ meal: 'lunch', amountPerHead: 1e9 }), /check the amount/);
  assert.match(err({ meal: 'lunch', amountPerHead: 100, effectiveFrom: '2026-13-40' }), /"from" date is not valid/);
  assert.match(err({ meal: 'lunch', amountPerHead: 100, effectiveTo: 'tomorrow' }), /"to" date is not valid/);
  assert.match(err({ meal: 'lunch', amountPerHead: 100, effectiveFrom: '2026-10-05', effectiveTo: '2026-10-01' }), /after the "to" date/);
  assert.match(err({ meal: 'lunch', amountPerHead: 100, note: 'x'.repeat(201) }), /too long/);
});

test('validateRule: two active rules for the same meal may not share a day; other meals, other dates and switched-off rules are fine', () => {
  const existing = [rule('lunch', 150, { effectiveFrom: '2026-10-01' })];
  const clash = validateRule({ meal: 'lunch', amountPerHead: 160 }, existing);
  assert.match(clash.error, /already an active lunch allowance/);
  assert.equal(clash.conflict, true);
  assert.ok(validateRule({ meal: 'lunch', amountPerHead: 160, effectiveTo: '2026-09-30' }, existing).clean, 'ends the day before');
  assert.ok(validateRule({ meal: 'dinner', amountPerHead: 160 }, existing).clean);
  assert.ok(validateRule({ meal: 'lunch', amountPerHead: 160, active: false }, existing).clean, 'a switched-off rule never clashes');
  assert.ok(validateRule({ meal: 'lunch', amountPerHead: 160 }, [rule('lunch', 150, { active: false })]).clean, 'and does not block');
});

test('team of 3 at ₹150 for lunch: the limit is ₹450 — ₹500 is over by ₹50', () => {
  const c = teamMealCheck({ heads: 3, allowancePerHead: 150, alreadySpent: 0, amount: 500 });
  assert.deepEqual(c, { heads: 3, allowancePerHead: 150, alreadySpent: 0, thisAmount: 500, total: 500, limit: 450, over: 50, status: 'over' });
});

test('what the team has already logged counts: ₹300 already + ₹200 now = ₹500 > ₹450', () => {
  const c = teamMealCheck({ heads: 3, allowancePerHead: 150, alreadySpent: 300, amount: 200 });
  assert.deepEqual([c.total, c.limit, c.over, c.status], [500, 450, 50, 'over']);
  assert.equal(c.alreadySpent, 300);
  assert.equal(c.thisAmount, 200);
});

test('within the limit, including exactly at it', () => {
  assert.deepEqual(teamMealCheck({ heads: 3, allowancePerHead: 150, alreadySpent: 300, amount: 100 }).status, 'within');
  const at = teamMealCheck({ heads: 3, allowancePerHead: 150, alreadySpent: 300, amount: 150 });
  assert.deepEqual([at.total, at.over, at.status], [450, 0, 'within'], 'exactly the limit is not over');
});

test('already over before this amount: the whole new amount is over too', () => {
  const c = teamMealCheck({ heads: 2, allowancePerHead: 100, alreadySpent: 260, amount: 40 });
  assert.deepEqual([c.limit, c.total, c.over], [200, 300, 100]);
});

test('no allowance set for the meal, or nobody assigned: no limit and nothing flagged', () => {
  const none = teamMealCheck({ heads: 3, allowancePerHead: null, amount: 999 });
  assert.deepEqual([none.status, none.limit, none.over], ['no_rule', null, 0]);
  const solo = teamMealCheck({ heads: 0, allowancePerHead: 150, amount: 999 });
  assert.deepEqual([solo.status, solo.limit, solo.over], ['no_heads', null, 0]);
  assert.equal(teamMealCheck({ heads: 3, allowancePerHead: undefined, amount: 1 }).status, 'no_rule');
});

test('a ₹0 allowance: any spend is over; paise are exact', () => {
  assert.deepEqual(teamMealCheck({ heads: 2, allowancePerHead: 0, amount: 1 }).over, 1);
  const c = teamMealCheck({ heads: 3, allowancePerHead: 33.33, alreadySpent: 99.98, amount: 0.02 });
  assert.deepEqual([c.limit, c.total, c.over, c.status], [99.99, 100, 0.01, 'over']);
});

// ── one entry covering SEVERAL meals (a long trip: breakfast + lunch + dinner on one bill) ──────────
const combo = (meals, amount) => ({ meal: '', meals, amount });

test('a combined entry is judged as ONE pool: heads × the sum of its meals\' allowances', () => {
  // 3 heads × (100 + 150 + 150) = ₹1200; ₹1350 spent → over by ₹150
  const r = compareFood({ rules: RULES, dayKey: '2026-10-30', heads: 3, lines: [combo(['breakfast', 'lunch', 'dinner'], 1350)] });
  assert.deepEqual(r.meals, [{ meal: 'breakfast+lunch+dinner', meals: ['breakfast', 'lunch', 'dinner'], actual: 1350, allowancePerHead: 400, allowed: 1200, over: 150, status: 'over' }]);
  assert.deepEqual([r.allowed, r.actual, r.over, r.hasOver], [1200, 1350, 150, true]);
});

test('a combined entry that is within its pool is not flagged, even when one meal alone would be', () => {
  // ₹330 for breakfast + lunch for ONE head: pool ₹250 → over; ₹240 → within (breakfast alone ₹240 would be over ₹100)
  const rules = RULES;
  assert.equal(compareFood({ rules, dayKey: 'd', heads: 1, lines: [combo(['breakfast', 'lunch'], 240)] }).hasOver, false);
  assert.equal(compareFood({ rules, dayKey: 'd', heads: 1, lines: [combo(['breakfast', 'lunch'], 330)] }).over, 80);
});

test('the meals can arrive in any order and are counted once', () => {
  const r = compareFood({ rules: RULES, dayKey: 'd', heads: 1, lines: [combo(['dinner', 'breakfast', 'breakfast'], 100)] });
  assert.deepEqual(r.meals[0].meals, ['breakfast', 'dinner']);
  assert.equal(r.meals[0].allowed, 250);
});

test('a pool with one meal that has no allowance is shown, not checked (never a partial limit)', () => {
  const rules = [rule('breakfast', 100), rule('dinner', 150)]; // no lunch rule
  const r = compareFood({ rules, dayKey: 'd', heads: 2, lines: [combo(['breakfast', 'lunch', 'dinner'], 9999)] });
  assert.deepEqual([r.meals[0].status, r.meals[0].allowed, r.meals[0].allowancePerHead], ['no_rule', null, null]);
  assert.deepEqual([r.allowed, r.actual, r.over, r.hasOver], [0, 0, 0, false]);
});

test('one-meal entries of a meal inside a combined entry join its pool (the lunch is not counted twice)', () => {
  // 1 head: pool breakfast+lunch+dinner = ₹400. ₹250 combined + a ₹200 lunch on its own = ₹450 → over ₹50
  const r = compareFood({ rules: RULES, dayKey: 'd', heads: 1, lines: [combo(['breakfast', 'lunch', 'dinner'], 250), f('lunch', 200)] });
  assert.equal(r.meals.length, 1);
  assert.deepEqual([r.meals[0].actual, r.meals[0].allowed, r.meals[0].over], [450, 400, 50]);
});

test('meals NOT in any combined entry stay their own pool', () => {
  const r = compareFood({ rules: RULES, dayKey: 'd', heads: 1, lines: [combo(['breakfast', 'lunch'], 200), f('dinner', 300), f('snacks', 10)] });
  assert.deepEqual(r.meals.map((m) => [m.meal, m.status]), [['breakfast+lunch', 'within'], ['snacks', 'within'], ['dinner', 'over']]);
});

test('two combined entries that share a meal become one pool', () => {
  const pools = mealPools([
    { meals: ['breakfast', 'lunch'], paise: 100 },
    { meals: ['lunch', 'dinner'], paise: 200 },
    { meals: ['snacks'], paise: 50 },
  ]);
  assert.deepEqual(pools, [{ meals: ['breakfast', 'lunch', 'dinner'], paise: 300 }, { meals: ['snacks'], paise: 50 }]);
});

test('combined entries: older rows with only `meal` still work, and an entry with neither is "no meal"', () => {
  const r = compareFood({ rules: RULES, dayKey: 'd', heads: 1, lines: [{ meal: 'lunch', amount: 100 }, { meal: '', meals: [], amount: 40 }] });
  assert.deepEqual(r.meals.map((m) => m.meal), ['lunch']);
  assert.equal(r.noMeal, 40);
});

test('poolPerHead / poolKey', () => {
  assert.equal(poolPerHead(RULES, ['breakfast', 'lunch', 'dinner'], 'd'), 400);
  assert.equal(poolPerHead([rule('lunch', 150)], ['lunch', 'dinner'], 'd'), null);
  assert.equal(poolKey(['dinner', 'breakfast']), 'breakfast+dinner');
  assert.equal(poolKey(['lunch']), 'lunch');
});

test('early morning work (< 8 AM IST) automatically grants ₹250 breakfast allowance', () => {
  // 06:30 AM IST = 01:00 UTC
  const earlyStart = new Date('2026-11-13T01:00:00.000Z');
  // 09:30 AM IST = 04:00 UTC
  const normalStart = new Date('2026-11-13T04:00:00.000Z');

  // Standard breakfast rule is ₹100 in RULES
  const normal = poolPerHead(RULES, ['breakfast'], 'd', { serviceStart: normalStart });
  assert.equal(normal, 100);

  // Early work before 8 AM IST automatically gets ₹250
  const early = poolPerHead(RULES, ['breakfast'], 'd', { serviceStart: earlyStart });
  assert.equal(early, 250);

  // Compare food on early work: 2 heads with breakfast of ₹500 (2 × 250) is within limit!
  const res = compareFood({ rules: RULES, dayKey: '2026-11-13', heads: 2, lines: [f('breakfast', 500)], serviceStart: earlyStart });
  assert.equal(res.allowed, 500);
  assert.equal(res.hasOver, false);
});
