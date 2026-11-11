// The FOOD ALLOWANCE per head: Accounts sets how much may be spent on each meal per person
// (breakfast ₹100, lunch ₹150 …), optionally between two dates. A work is then checked meal by
// meal: what was spent on lunch under the work against heads × the lunch allowance.
//
//   • Heads are everyone assigned to the work (utils/perHead.js).
//   • The rule that applies is the active one for that meal whose dates include the WORK's day;
//     when two are in range the one that started later wins. No rule for a meal → not checked.
//   • Over the allowance is FLAGGED, never cut: the full amount stays the work's cost.
//
// Pure — tests/foodAllowance.test.js.

import { MEALS, mealsOf } from './mealAllocation.js';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const toPaise = (rupees) => Math.round((Number(rupees) || 0) * 100);
const toRupees = (paise) => paise / 100;
const MAX_PER_HEAD = 100000;

const validDay = (s) => {
  if (!DAY_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/// Do two rules' date ranges share a day? An empty side is open ("from the beginning" / "no end").
export const rangesOverlap = (a, b) => {
  const aFrom = a.effectiveFrom || '0000-00-00';
  const bFrom = b.effectiveFrom || '0000-00-00';
  const aTo = a.effectiveTo || '9999-99-99';
  const bTo = b.effectiveTo || '9999-99-99';
  return aFrom <= bTo && bFrom <= aTo;
};

/**
 * Checks and cleans what a client sent for a rule.
 * @param {object} input     { meal, amountPerHead, effectiveFrom, effectiveTo, active, note }
 * @param {Array}  existing  the other rules (the one being edited left out)
 * @returns {{ error: string } | { clean: object }}
 */
export const validateRule = (input, existing = []) => {
  const meal = String(input.meal ?? '');
  if (!MEALS.includes(meal)) return { error: 'Choose a meal: breakfast, lunch, snacks or dinner.' };

  const raw = input.amountPerHead;
  const amount = typeof raw === 'string' ? Number(raw.trim()) : Number(raw);
  if (raw === '' || raw == null || !Number.isFinite(amount) || amount < 0) return { error: 'Enter the amount allowed per head (0 or more).' };
  if (amount > MAX_PER_HEAD) return { error: `That is more than ₹${MAX_PER_HEAD.toLocaleString('en-IN')} per head — check the amount.` };

  const effectiveFrom = String(input.effectiveFrom ?? '').trim();
  const effectiveTo = String(input.effectiveTo ?? '').trim();
  if (effectiveFrom && !validDay(effectiveFrom)) return { error: 'The "from" date is not valid (YYYY-MM-DD).' };
  if (effectiveTo && !validDay(effectiveTo)) return { error: 'The "to" date is not valid (YYYY-MM-DD).' };
  if (effectiveFrom && effectiveTo && effectiveFrom > effectiveTo) return { error: 'The "from" date is after the "to" date.' };

  const note = String(input.note ?? '').trim();
  if (note.length > 200) return { error: 'The note is too long (200 characters at most).' };
  const active = input.active === undefined ? true : input.active === true || input.active === 'true';

  const clean = { meal, amountPerHead: Math.round(amount * 100) / 100, effectiveFrom, effectiveTo, active, note };
  if (active) {
    const clash = existing.find((r) => r.active && r.meal === meal && rangesOverlap(r, clean));
    if (clash) {
      return { error: `There is already an active ${meal} allowance for those dates (₹${clash.amountPerHead} per head). Change its dates or switch it off first.`, conflict: true };
    }
  }
  return { clean };
};

/**
 * Is the TEAM'S spend on one meal of one work over its limit? The limit is heads × the allowance
 * per head; what counts is everything the team has logged for that meal on that work PLUS the
 * amount being entered now.
 * @param {object} o  { heads, allowancePerHead (null = no allowance set), alreadySpent, amount }
 * @returns {{ heads, allowancePerHead, limit, alreadySpent, thisAmount, total, over, status }}
 *   status  over | within | no_rule (no allowance for the meal) | no_heads (nobody assigned) — limit is null for the last two
 */
export const teamMealCheck = ({ heads = 0, allowancePerHead = null, alreadySpent = 0, amount = 0 }) => {
  const spent = toPaise(alreadySpent);
  const now = toPaise(amount);
  const base = { heads, allowancePerHead, alreadySpent: toRupees(spent), thisAmount: toRupees(now), total: toRupees(spent + now) };
  if (allowancePerHead === null || allowancePerHead === undefined) return { ...base, limit: null, over: 0, status: 'no_rule' };
  if (!(heads > 0)) return { ...base, limit: null, over: 0, status: 'no_heads' };
  const limit = Math.round(toPaise(allowancePerHead) * heads);
  const over = Math.max(0, spent + now - limit);
  return { ...base, limit: toRupees(limit), over: toRupees(over), status: over > 0 ? 'over' : 'within' };
};

export const isEarlyWork = (serviceStart) => {
  if (!serviceStart) return false;
  const d = new Date(serviceStart);
  if (Number.isNaN(d.getTime())) return false;
  // IST is UTC + 5:30
  const istMinutes = d.getUTCHours() * 60 + d.getUTCMinutes() + 330;
  const istHour = Math.floor(istMinutes / 60) % 24;
  return istHour < 8;
};

/// The rule in force for [meal] on [dayKey] ('YYYY-MM-DD', IST), or null.
/// When work starts before 8:00 AM (early morning call time), breakfast allowance is ₹250 per head.
export const ruleFor = (rules, meal, dayKey, isEarly = false) => {
  const baseRule = (rules ?? [])
    .filter((r) => r.active !== false && r.meal === meal && (!r.effectiveFrom || r.effectiveFrom <= dayKey) && (!r.effectiveTo || dayKey <= r.effectiveTo))
    .sort((a, b) => String(b.effectiveFrom || '').localeCompare(String(a.effectiveFrom || '')))[0] ?? null;

  if (meal === 'breakfast' && isEarly) {
    const earlyRule = (rules ?? [])
      .filter((r) => r.active !== false && r.meal === 'early_breakfast' && (!r.effectiveFrom || r.effectiveFrom <= dayKey) && (!r.effectiveTo || dayKey <= r.effectiveTo))
      .sort((a, b) => String(b.effectiveFrom || '').localeCompare(String(a.effectiveFrom || '')))[0];
    if (earlyRule) return earlyRule;
    if (baseRule) {
      return { ...baseRule, amountPerHead: 250, isEarly: true };
    }
  }

  return baseRule;
};

/// The allowance per head for a SET of meals taken together — the sum of each meal's allowance on
/// [dayKey]. null as soon as one of the meals has no allowance set: the set cannot be checked
/// fully, and a partial limit would flag food it was never meant to cover.
export const poolPerHead = (rules, meals, dayKey, { serviceStart = null, isEarly = false } = {}) => {
  const early = isEarly || isEarlyWork(serviceStart);
  let paise = 0;
  for (const m of meals) {
    const rule = ruleFor(rules, m, dayKey, early);
    if (!rule) return null;
    paise += toPaise(rule.amountPerHead);
  }
  return toRupees(paise);
};

/**
 * Meals that were paid TOGETHER are one pool. An entry that covers breakfast + lunch + dinner ties
 * those meals together; another entry touching any of them joins the same pool. A pool is judged
 * as one: what was spent on it against heads × the sum of its meals' allowances. With only
 * one-meal entries every meal is its own pool — exactly the old meal-by-meal check.
 * @param {Array<{ meals: string[], paise: number }>} entries
 * @returns {Array<{ meals: string[], paise: number }>}  pools, ordered by their first meal of the day
 */
export const mealPools = (entries) => {
  const parent = new Map(MEALS.map((m) => [m, m]));
  const find = (m) => {
    while (parent.get(m) !== m) m = parent.get(m);
    return m;
  };
  for (const e of entries) {
    for (let i = 1; i < e.meals.length; i++) parent.set(find(e.meals[i]), find(e.meals[0]));
  }
  const pools = new Map();
  for (const e of entries) {
    if (e.meals.length === 0) continue;
    const root = find(e.meals[0]);
    if (!pools.has(root)) pools.set(root, { meals: new Set(), paise: 0 });
    const p = pools.get(root);
    e.meals.forEach((m) => p.meals.add(m));
    p.paise += e.paise;
  }
  return [...pools.values()]
    .map((p) => ({ meals: MEALS.filter((m) => p.meals.has(m)), paise: p.paise }))
    .sort((a, b) => MEALS.indexOf(a.meals[0]) - MEALS.indexOf(b.meals[0]));
};

/// The meals of a pool as one key: 'lunch' for a single meal, 'breakfast+lunch+dinner' for a pool.
export const poolKey = (meals) => canonical(meals).join('+');
const canonical = (meals) => MEALS.filter((m) => meals.includes(m));

/**
 * One work's food against the allowance.
 * @param {object} o
 * @param {Array}  o.rules    every allowance rule
 * @param {string} o.dayKey   the work's IST day
 * @param {number} o.heads    everyone assigned to the work
 * @param {Array}  o.lines    the food spent under the work: [{ meal, meals?, amount }] — `meals` when one
 *                            entry covers several meals
 * @returns {{ meals: Array<{ meal, meals, actual, allowancePerHead, allowed, over, status }>, allowed, actual, over, hasOver, noMeal }}
 *   meal     the meal, or for a pool of meals paid together their key ('breakfast+lunch+dinner'); `meals` lists them
 *   status   over | within | no_rule (no allowance set for one of the meals) | no_heads (nobody assigned)
 *   allowancePerHead   a pool's is the sum over its meals
 *   allowed / actual / over   over the pools that have a rule (the ones that were checked)
 *   noMeal   food with no meal recorded — spent, but not checkable against a per-meal allowance
 */
export const compareFood = ({ rules = [], dayKey, heads = 0, lines = [], serviceStart = null }) => {
  let noMealPaise = 0;
  const entries = [];
  for (const l of lines) {
    const paise = toPaise(l.amount);
    const meals = mealsOf(l);
    if (meals.length > 0) entries.push({ meals, paise });
    else noMealPaise += paise;
  }

  const rows = [];
  let allowedPaise = 0;
  let actualPaise = 0;
  let overPaise = 0;
  for (const pool of mealPools(entries)) {
    const actual = pool.paise;
    if (!actual) continue;
    const perHead = poolPerHead(rules, pool.meals, dayKey, { serviceStart });
    const base = { meal: poolKey(pool.meals), meals: pool.meals, actual: toRupees(actual) };
    if (perHead === null) {
      rows.push({ ...base, allowancePerHead: null, allowed: null, over: 0, status: 'no_rule' });
      continue;
    }
    if (!(heads > 0)) {
      rows.push({ ...base, allowancePerHead: perHead, allowed: null, over: 0, status: 'no_heads' });
      continue;
    }
    const allowed = Math.round(toPaise(perHead) * heads);
    const over = Math.max(0, actual - allowed);
    allowedPaise += allowed;
    actualPaise += actual;
    overPaise += over;
    rows.push({ ...base, allowancePerHead: perHead, allowed: toRupees(allowed), over: toRupees(over), status: over > 0 ? 'over' : 'within' });
  }
  return { meals: rows, allowed: toRupees(allowedPaise), actual: toRupees(actualPaise), over: toRupees(overPaise), hasOver: overPaise > 0, noMeal: toRupees(noMealPaise) };
};
