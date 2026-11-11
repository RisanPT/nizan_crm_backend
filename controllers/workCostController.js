import mongoose from 'mongoose';
import Expense from '../models/Expense.js';
import Employee from '../models/Employee.js';
import { istStart, istEnd, istDayKey, parseDayParam, todayIst } from '../utils/istDate.js';
import { placeMeals, mealDayKey, workPeriod, canonicalMeals, mealsOf } from '../utils/mealAllocation.js';
import { loadArtistDayWorks } from '../services/artistDay.js';
import { computeAllocations, workDistanceKm } from '../services/mealAllocation.js';
import { escapeRegex } from '../utils/financeListQuery.js';
import { perHead } from '../utils/perHead.js';
import { compareFood, poolPerHead } from '../utils/foodAllowance.js';
import { teamMealStates, teamMealKey } from '../services/teamMealLimit.js';
import FoodAllowance from '../models/FoodAllowance.js';
import { artistsOf } from '../utils/workArtists.js';

// What each WORK cost, with the artists' food placed by the time of the meal
// (utils/mealAllocation.js): the artist's preview while adding a meal, one artist's
// day as a timeline, and the Accounts report of cost per work.

const ACCOUNTS_ROLES = new Set(['accounts', 'finance_head', 'admin']);
const EXPORT_CAP = 5000;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const CATEGORIES = ['food', 'travel', 'stay', 'materials', 'fuel', 'other'];

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const fail = (res, err) => res.status(err.status ?? 500).json({ message: err.message });

const workRow = (w) => ({
  bookingId: String(w.booking._id),
  bookingNumber: w.booking.bookingNumber ?? '',
  customerName: w.booking.customerName ?? '',
  service: w.booking.service ?? '',
  serviceStart: w.booking.serviceStart,
  serviceEnd: w.booking.serviceEnd,
  period: workPeriod(w.booking),
  // how far the venue is (km, 0 = not recorded) — Accounts reads it beside the food bill
  travelDistanceKm: workDistanceKm(w.booking),
});

/**
 * @desc   The artist's preview while adding a meal: which of THEIR works that day it would be
 *         counted under, and why. ?at= (ISO time of the meal) &meals= (breakfast,lunch,dinner — one
 *         bill may cover several) or the older &meal= (breakfast|lunch|snacks|dinner)
 *         Optional: &bookingId= (the work the artist chose instead) and &excludeId= (an expense being
 *         edited, left out of what the team has already logged).
 * @route  GET /api/expenses/meal-preview
 * @access Private — an artist (their own works); Accounts / admin may pass ?employeeId=
 * @returns { dayKey, meals, works: [...the day's works, in time order, each with travelDistanceKm],
 *            suggestion: { bookingId|null, mode (time|single|last|unallocated), reason, flag, minutes },
 *            team: { workId, pinned, heads, allowancePerHead (sum over the pool), limit, alreadySpent, meals (the pool) } | null,
 *            allowance: { amountPerHead (sum over the selected meals), heads } | null }
 */
export const getMealPreview = async (req, res) => {
  try {
    // an artist previews for themselves; Accounts / admin, adding on an artist's behalf, name them
    const forOther = ACCOUNTS_ROLES.has(req.user?.role) && mongoose.isValidObjectId(req.query.employeeId);
    const employeeId = forOther ? String(req.query.employeeId) : String(req.user?.employeeId ?? '');
    const at = new Date(String(req.query.at ?? ''));
    if (Number.isNaN(at.getTime())) throw bad('Say when the meal was (at=)');
    const meals = canonicalMeals(req.query.meals ?? req.query.meal ?? '');
    if (meals.length === 0) throw bad('Say which meal it was');
    if (!employeeId) return res.json({ dayKey: mealDayKey(at), meals, works: [], suggestion: { bookingId: null, mode: 'unallocated', reason: 'No work on this day to put it under.', flag: '', minutes: null } });

    const dayKey = mealDayKey(at);
    const works = await loadArtistDayWorks(employeeId, dayKey);
    const placed = placeMeals({
      at,
      meals,
      works: works.map((b) => ({ id: String(b._id), serviceStart: b.serviceStart, serviceEnd: b.serviceEnd })),
    });
    // the work the meal counts under: the one the artist chose, else the suggested one
    const pinnedId = mongoose.isValidObjectId(req.query.bookingId) ? String(req.query.bookingId) : '';
    const countedUnder = pinnedId || placed.workId;
    const targetWork = works.find((w) => String(w._id) === String(countedUnder));
    // the allowance for the selected meals together (the sum of each); null when one of them has none set
    const perHead = poolPerHead(await FoodAllowance.find({ active: true, meal: { $in: [...meals, 'early_breakfast'] } }).lean(), meals, dayKey, { serviceStart: targetWork?.serviceStart });
    let team = null;
    if (countedUnder) {
      const state = (await teamMealStates([{ workId: countedUnder, meals }], { excludeExpenseId: req.query.excludeId })).get(teamMealKey(countedUnder, meals));
      if (state) {
        team = {
          workId: state.workId,
          pinned: !!pinnedId,
          heads: state.heads,
          allowancePerHead: state.allowancePerHead,
          limit: state.allowancePerHead !== null && state.heads > 0 ? Math.round(state.allowancePerHead * state.heads * 100) / 100 : null,
          alreadySpent: state.alreadySpent,
          // the meals the limit is for: the ones selected, plus any the team tied to them on this work
          meals: state.meals,
        };
      }
    }
    res.json({
      dayKey,
      meals,
      works: works.map((b) => ({
        bookingId: String(b._id),
        bookingNumber: b.bookingNumber ?? '',
        customerName: b.customerName ?? '',
        service: b.service ?? '',
        serviceStart: b.serviceStart,
        serviceEnd: b.serviceEnd,
        period: workPeriod(b),
        travelDistanceKm: workDistanceKm(b),
      })),
      suggestion: { bookingId: placed.workId, mode: placed.mode, basis: placed.basis, period: placed.period, reason: placed.reason, flag: placed.flag, minutes: placed.minutes },
      // the TEAM's limit for this meal on the work (the one the artist chose, else the suggested one):
      // heads × allowance per head, and what the team has already logged — so the form can say
      // "limit exceeded" as the amount is typed.
      team,
      allowance:
        team && team.allowancePerHead !== null
          ? { amountPerHead: team.allowancePerHead, heads: team.heads }
          : perHead !== null
            ? { amountPerHead: perHead, heads: 0 }
            : null,
    });
  } catch (err) {
    fail(res, err);
  }
};

const expenseLine = (e, alloc) => ({
  expenseId: String(e._id),
  category: e.category,
  meal: e.meal || '',
  meals: mealsOf(e),
  at: e.date,
  amount: e.amount,
  status: e.status,
  counted: e.status !== 'rejected',
  notes: e.notes || '',
  mode: alloc?.mode ?? '',
  reason: alloc?.reason ?? '',
  flag: alloc?.flag ?? '',
});

/**
 * @desc   One artist's day as a timeline: their works in time order, each with the costs placed
 *         under it (food by the time of the meal), and what could not be placed.
 * @route  GET /api/expenses/artist-day?employeeId=&day=YYYY-MM-DD
 * @access Private — Accounts / admin, or an artist for their own day
 */
export const getArtistDay = async (req, res) => {
  try {
    const role = req.user?.role;
    const isOwner = role === 'artist';
    if (!isOwner && !ACCOUNTS_ROLES.has(role)) throw bad('Not authorized', 403);
    const employeeId = isOwner ? String(req.user.employeeId ?? '') : String(req.query.employeeId ?? '');
    if (!mongoose.isValidObjectId(employeeId)) throw bad('Say which artist (employeeId=)');
    const day = req.query.day ? parseDayParam(req.query.day) : todayIst();
    if (!day) throw bad('That day is not valid (day=YYYY-MM-DD)');

    const [employee, works, expenses] = await Promise.all([
      Employee.findById(employeeId).select('name').lean(),
      loadArtistDayWorks(employeeId, day),
      Expense.find({ employeeId, date: { $gte: istStart(day), $lte: istEnd(day) } })
        .populate('bookingId', 'bookingNumber customerName service serviceStart serviceEnd travelDistanceKm bookingItems.travelDistanceKm')
        .sort({ date: 1, createdAt: 1 })
        .lean(),
    ]);
    const { byExpense, bookings } = await computeAllocations(expenses);

    const rows = works.map((b) => ({
      ...workRow({ booking: b }),
      place: bookings.get(String(b._id))?.place ?? '',
      food: 0,
      other: 0,
      total: 0,
      expenses: [],
    }));
    const byWork = new Map(rows.map((r) => [r.bookingId, r]));
    const unplaced = [];
    const totals = { food: 0, other: 0, all: 0, unplaced: 0 };

    for (const e of expenses) {
      const alloc = byExpense.get(String(e._id));
      const line = expenseLine(e, alloc);
      const counted = line.counted;
      const shares = alloc?.shares ?? [];
      if (shares.length === 0) {
        unplaced.push(line);
        if (counted) totals.unplaced = round2(totals.unplaced + e.amount);
        continue;
      }
      for (const s of shares) {
        let row = byWork.get(s.bookingId);
        if (!row) {
          // tied (pinned) to a work that is not on this day's list
          const info = bookings.get(s.bookingId);
          row = { ...(info ?? { bookingId: s.bookingId }), outsideDay: true, food: 0, other: 0, total: 0, expenses: [] };
          byWork.set(s.bookingId, row);
          rows.push(row);
        }
        row.expenses.push({ ...line, amount: s.amount });
        if (counted) {
          if (e.category === 'food') row.food = round2(row.food + s.amount);
          else row.other = round2(row.other + s.amount);
          row.total = round2(row.total + s.amount);
        }
      }
      if (counted) {
        if (e.category === 'food') totals.food = round2(totals.food + e.amount);
        else totals.other = round2(totals.other + e.amount);
        totals.all = round2(totals.all + e.amount);
      }
    }
    res.json({ employee: { id: employeeId, name: employee?.name ?? '' }, dayKey: day, works: rows, unplaced, totals });
  } catch (err) {
    fail(res, err);
  }
};

const parseStatuses = (raw) => {
  const list = String(raw ?? 'pending,verified').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.some((s) => !['pending', 'verified', 'rejected'].includes(s))) throw bad('Status must be pending, verified or rejected');
  return list;
};

/**
 * @desc   Cost per work: for the expenses in a period, what each work cost — food placed by
 *         the time of the meal — with what could not be placed alongside.
 *         ?from= &to= (IST days) &employeeId= &status=pending,verified (default) &search= (client / booking no.)
 *         ?page= &limit= (a page of works) or ?export=1 (every work, with its lines; capped)
 * @route  GET /api/expenses/work-costs
 * @access Private — Accounts / admin
 * @returns { items: [{ bookingId, bookingNumber, customerName, service, serviceStart, artists, food, travel, stay,
 *            materials, fuel, other, total, expenseCount, pendingCount, lines: [...],
 *            heads (everyone assigned: lead + assistants), foodPerHead (food ÷ heads | null),
 *            people: [{ employeeId, name, roleType, assigned, food }],
 *            travelDistanceKm (0 = not recorded),
 *            allowance: { meals: [{ meal (key: 'lunch' or 'breakfast+lunch+dinner'), meals, actual, allowancePerHead, allowed, over, status }], allowed, actual, over, hasOver, noMeal } }],
 *            page, limit, totalItems, totalPages,
 *            totals: { food, other, total, unplaced, unplacedCount }, truncated }
 */
export const getWorkCosts = async (req, res) => {
  try {
    if (!ACCOUNTS_ROLES.has(req.user?.role)) throw bad('Not authorized', 403);
    const { from, to, employeeId, search } = req.query;
    const filter = { status: { $in: parseStatuses(req.query.status) } };
    const gte = from ? parseDayParam(from) : null;
    const lte = to ? parseDayParam(to) : null;
    if ((from && !gte) || (to && !lte)) throw bad('from / to must be days (YYYY-MM-DD)');
    if (gte || lte) filter.date = { ...(gte ? { $gte: istStart(gte) } : {}), ...(lte ? { $lte: istEnd(lte) } : {}) };
    if (employeeId) {
      if (!mongoose.isValidObjectId(employeeId)) throw bad('That artist is not valid');
      filter.employeeId = employeeId;
    }

    const [expenses, count] = await Promise.all([
      Expense.find(filter)
        .populate('bookingId', 'bookingNumber customerName service serviceStart serviceEnd travelDistanceKm bookingItems.travelDistanceKm')
        .populate('employeeId', 'name')
        .sort({ date: -1 })
        .limit(EXPORT_CAP)
        .lean(),
      Expense.countDocuments(filter),
    ]);
    const { byExpense, bookings } = await computeAllocations(expenses);

    const works = new Map(); // bookingId → row
    const totals = { food: 0, other: 0, total: 0, unplaced: 0, unplacedCount: 0, overAllowanceCount: 0, overAllowanceAmount: 0 };
    const rules = await FoodAllowance.find({ active: true }).lean();
    for (const e of expenses) {
      const alloc = byExpense.get(String(e._id));
      const shares = alloc?.shares ?? [];
      if (shares.length === 0) {
        totals.unplaced = round2(totals.unplaced + e.amount);
        totals.unplacedCount += 1;
        continue;
      }
      for (const s of shares) {
        const info = bookings.get(s.bookingId) ?? { bookingId: s.bookingId };
        if (!works.has(s.bookingId)) {
          works.set(s.bookingId, {
            ...info,
            artists: info.artists ?? [],
            food: 0, travel: 0, stay: 0, materials: 0, fuel: 0, other: 0, total: 0,
            expenseCount: 0, pendingCount: 0,
            lines: [],
          });
        }
        const row = works.get(s.bookingId);
        const cat = CATEGORIES.includes(e.category) ? e.category : 'other';
        row[cat] = round2(row[cat] + s.amount);
        row.total = round2(row.total + s.amount);
        row.expenseCount += 1;
        if (e.status === 'pending') row.pendingCount += 1;
        row.lines.push({
          ...expenseLine(e, alloc),
          amount: s.amount,
          artist: e.employeeId?.name ?? '',
          employeeId: String(e.employeeId?._id ?? e.employeeId ?? ''),
        });
        if (cat === 'food') totals.food = round2(totals.food + s.amount);
        else totals.other = round2(totals.other + s.amount);
        totals.total = round2(totals.total + s.amount);
      }
    }

    // Per head: the work's food over everyone assigned to it, and what each person spent.
    for (const row of works.values()) {
      const { heads, foodPerHead, people } = perHead({
        people: row.people ?? [],
        lines: row.lines.filter((l) => l.category === 'food').map((l) => ({ employeeId: l.employeeId, name: l.artist, amount: l.amount })),
      });
      row.heads = heads;
      row.foodPerHead = foodPerHead;
      row.people = people;
      // …and against the food allowance: each meal's spend against heads × the allowance for it,
      // by the rule in force on the work's day. Over is flagged, never cut.
      row.allowance = compareFood({
        rules,
        dayKey: row.serviceStart ? istDayKey(row.serviceStart) : '',
        heads,
        serviceStart: row.serviceStart,
        lines: row.lines.filter((l) => l.category === 'food' && l.counted).map((l) => ({ meal: l.meal, meals: l.meals, amount: l.amount })),
      });
      if (row.allowance.hasOver) {
        totals.overAllowanceCount += 1;
        totals.overAllowanceAmount = round2(totals.overAllowanceAmount + row.allowance.over);
      }
    }

    let items = [...works.values()];
    const q = String(search ?? '').trim();
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      items = items.filter((w) => rx.test(w.customerName ?? '') || rx.test(w.bookingNumber ?? '') || (w.artists ?? []).some((a) => rx.test(a)));
    }
    items.sort((a, b) => new Date(b.serviceStart ?? 0) - new Date(a.serviceStart ?? 0) || String(a.bookingId).localeCompare(String(b.bookingId)));

    const truncated = count > EXPORT_CAP;
    if (req.query.export === '1') return res.json({ items, totalItems: items.length, totals, truncated });
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    res.json({
      items: items.slice((page - 1) * limit, page * limit),
      page,
      limit,
      totalItems: items.length,
      totalPages: Math.max(1, Math.ceil(items.length / limit)),
      totals,
      truncated,
    });
  } catch (err) {
    fail(res, err);
  }
};
