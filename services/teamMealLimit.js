import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import Expense from '../models/Expense.js';
import FoodAllowance from '../models/FoodAllowance.js';
import { poolPerHead } from '../utils/foodAllowance.js';
import { artistsOf } from '../utils/workArtists.js';
import { canonicalMeals, mealsOf } from '../utils/mealAllocation.js';
import { istDayKey, istStart, istEnd } from '../utils/istDate.js';
import { computeAllocations } from './mealAllocation.js';
import { ARTIST_WORK_FIELDS } from './artistDay.js';

// The TEAM'S limit on the meal(s) of one work, and what the team has already logged against it.
//   limit        = heads × the food allowance per head (utils/foodAllowance.js), heads = everyone
//                  assigned to the work (lead + assistants)
//   alreadySpent = every counted (not rejected) food expense for that meal that is placed under
//                  the work — by anyone on the team — using the same placement rules as Accounts
//                  sees (utils/mealAllocation.js), so the artist and Accounts always agree.
// An expense being EDITED is left out (excludeExpenseId), so changing its amount is judged fresh.
//
// ONE ENTRY MAY COVER SEVERAL MEALS (breakfast + lunch + dinner on one bill). Meals paid together are
// one POOL (utils/foodAllowance.js mealPools): the entry being checked brings its meals, and any
// other entry touching one of them brings its own too. The pool's allowance per head is the SUM of
// its meals' allowances, and what counts against it is everything the team logged for those meals.
// For one meal on its own the pool is just that meal — the old meal-by-meal check.

const keyOf = (workId, meals) => `${workId}|${canonicalMeals(meals).join('+')}`;

/**
 * @param {Array<{ workId, meal?, meals? }>} pairs   the meal(s) to check on each work
 * @param {object} [o]  { excludeExpenseId }
 * @returns {Promise<Map<string, { workId, meal, meals, heads, dayKey, allowancePerHead: number|null, alreadySpent: number }>>}
 *   keyed by teamMealKey(workId, meals) of the REQUESTED meals; `meals` is the whole pool (it can be wider
 *   than the request when other entries tie more meals in); a work that does not exist is simply absent
 */
export const teamMealStates = async (pairs, { excludeExpenseId = null } = {}) => {
  const wanted = new Map(); // key → { workId, meals }
  for (const p of pairs) {
    const meals = canonicalMeals(p?.meals ?? (p?.meal ? [p.meal] : []));
    if (p?.workId && meals.length > 0 && mongoose.isValidObjectId(String(p.workId))) {
      wanted.set(keyOf(String(p.workId), meals), { workId: String(p.workId), meals });
    }
  }
  const out = new Map();
  if (wanted.size === 0) return out;

  const workIds = [...new Set([...wanted.values()].map((w) => w.workId))];
  const [works, rules] = await Promise.all([
    Booking.find({ _id: { $in: workIds } }).select(ARTIST_WORK_FIELDS).lean(),
    FoodAllowance.find({ active: true }).lean(),
  ]);
  const byId = new Map(works.map((b) => [String(b._id), b]));
  const info = new Map(
    works.map((b) => {
      const people = artistsOf(b);
      return [
        String(b._id),
        {
          heads: people.length,
          headIds: people.map((p) => p.employeeId),
          dayKey: istDayKey(b.serviceStart),
          serviceStart: b.serviceStart,
        },
      ];
    }),
  );

  // everything the team has logged: tied to the work, or the team's own food that day. (Every meal, not just
  // the requested ones — an entry covering several meals can tie the requested meal to others.)
  const headIds = [...new Set([...info.values()].flatMap((i) => i.headIds))];
  const days = [...info.values()].map((i) => i.dayKey).sort();
  const candidates =
    info.size === 0
      ? []
      : (
          await Expense.find({
            category: 'food',
            workType: 'bridal',
            status: { $ne: 'rejected' },
            ...(excludeExpenseId && mongoose.isValidObjectId(String(excludeExpenseId)) ? { _id: { $ne: excludeExpenseId } } : {}),
            $or: [
              { bookingId: { $in: workIds.filter((id) => byId.has(id)) } },
              { bookingId: null, employeeId: { $in: headIds }, date: { $gte: istStart(days[0]), $lte: istEnd(days[days.length - 1]) } },
            ],
          })
            .select('employeeId bookingId category meal meals amount date workType status')
            .lean()
        ).filter((c) => mealsOf(c).length > 0);
  const { byExpense } = await computeAllocations(candidates);

  // per work: what each entry placed there cost, and which meals it covers
  const placed = new Map(); // workId → [{ meals, paise }]
  for (const c of candidates) {
    const meals = mealsOf(c);
    for (const s of byExpense.get(String(c._id))?.shares ?? []) {
      if (!placed.has(s.bookingId)) placed.set(s.bookingId, []);
      placed.get(s.bookingId).push({ meals, paise: Math.round((Number(s.amount) || 0) * 100) });
    }
  }

  for (const [k, w] of wanted) {
    const i = info.get(w.workId);
    if (!i) continue;
    // grow the pool: any entry touching a meal in it brings its other meals in
    const entries = placed.get(w.workId) ?? [];
    const pool = new Set(w.meals);
    for (let changed = true; changed; ) {
      changed = false;
      for (const e of entries) {
        if (e.meals.some((m) => pool.has(m)) && e.meals.some((m) => !pool.has(m))) {
          e.meals.forEach((m) => pool.add(m));
          changed = true;
        }
      }
    }
    const meals = canonicalMeals([...pool]);
    const spent = entries.filter((e) => e.meals.some((m) => pool.has(m))).reduce((sum, e) => sum + e.paise, 0);
    const perHead = poolPerHead(rules, meals, i.dayKey, { serviceStart: i.serviceStart });
    out.set(k, {
      workId: w.workId,
      meal: meals.length === 1 ? meals[0] : '',
      meals,
      heads: i.heads,
      dayKey: i.dayKey,
      allowancePerHead: perHead,
      alreadySpent: spent / 100,
    });
  }
  return out;
};

export const teamMealKey = keyOf;
