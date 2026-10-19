import Goal from '../models/Goal.js';
import Booking from '../models/Booking.js';
import Lead from '../models/Lead.js';
import Trial from '../models/Trial.js';
import { regionScopedMatch } from '../utils/geoScope.js';
import { makeCountsTowardSales } from '../utils/salesRules.js';
import { isSale, netValue } from './dashboardController.js';
import { istDayKey, istEnd, istStart, isDay, parseDayParam, todayIst } from '../utils/istDate.js';
import {
  METRICS,
  PERIOD_TYPES,
  emptyDay,
  fillDays,
  mtdFigures,
  pct,
  periodOf,
  sumDays,
} from '../utils/goalMath.js';

// Company-wide goals (day / week / month) and the day-wise report that sets
// them against actuals. Rules match the Sales dashboard:
//  • Dates are IST calendar days; weeks start on Monday.
//  • bookings / revenue count only real sales (not cancelled / rejected / lost /
//    draft / pending, not bookings by users excluded from sales totals);
//    revenue = totalPrice − discountAmount.
//  • basis=added (default) → a booking / lead / trial counts on the day it was
//    made; basis=event → on its event / trial date.
//  • A period's total is the sum of its days, so day, week and month always
//    reconcile.

const lc = (v) => String(v ?? '').trim().toLowerCase();

// Roles that can set goals: admin / manager, and sales or marketing managers
// (e.g. sales_manager, marketing_manager, marketing_admin).
const canSetGoals = (user) => {
  const r = lc(user?.role);
  return r === 'admin' || r === 'manager' || /^(sales|marketing)_?.*(manager|admin|head)$/.test(r);
};

// Company-level goals would mislead if compared with a salesperson's own
// numbers, and field staff have no use for the report.
const NO_REPORT_ROLES = ['artist', 'driver', 'sales', 'sales_executive'];

const deny = (req, res) => {
  if (NO_REPORT_ROLES.includes(lc(req.user?.role))) {
    res.status(403).json({ message: 'No access to the goals report' });
    return true;
  }
  return false;
};

const sendError = (res, error) => res.status(500).json({ message: error.message });

const anchorOf = (value) => parseDayParam(value) || todayIst();

const basisOf = (q) => (lc(q.basis) === 'event' ? 'event' : 'added');

/// Per-day actuals { leads, bookings, revenue, trials } for [from, to] (IST days).
const actualsByDay = async (user, from, to, basis) => {
  const byDay = new Map();
  const bump = (day, key, n) => {
    const r = byDay.get(day) ?? emptyDay();
    r[key] += n;
    byDay.set(day, r);
  };
  const range = { $gte: istStart(from), $lte: istEnd(to) };
  const bookingField = basis === 'event' ? 'bookingDate' : 'createdAt';

  const geo = await regionScopedMatch(user);
  const [bookings, counts, leads, trials] = await Promise.all([
    Booking.find({ $and: [geo, { [bookingField]: range }] })
      .select('status totalPrice discountAmount createdAt bookingDate createdBy')
      .limit(100000)
      .lean(),
    makeCountsTowardSales(),
    Lead.find({
      $and: [geo, { $or: [{ leadDate: range }, { leadDate: null, createdAt: range }] }],
    })
      .select('leadDate createdAt')
      .limit(100000)
      .lean(),
    Trial.find(
      basis === 'event'
        ? { trialDate: { $gte: from, $lte: to }, status: { $ne: 'cancelled' } }
        : { createdAt: range, status: { $ne: 'cancelled' } }
    )
      .select('trialDate createdAt')
      .limit(100000)
      .lean(),
  ]);

  for (const b of bookings) {
    if (!isSale(b) || !counts(b)) continue;
    const day = istDayKey(b[bookingField]);
    bump(day, 'bookings', 1);
    bump(day, 'revenue', netValue(b));
  }
  for (const l of leads) bump(istDayKey(l.leadDate || l.createdAt), 'leads', 1);
  for (const t of trials) {
    const day = basis === 'event' ? String(t.trialDate || '').slice(0, 10) : istDayKey(t.createdAt);
    if (isDay(day)) bump(day, 'trials', 1);
  }
  return byDay;
};

/// Goals as { 'metric|periodType|periodStart': value } for a set of period starts.
const goalMap = async (periodType, starts) => {
  const docs = await Goal.find({ periodType, periodStart: { $in: starts } }).lean();
  return new Map(docs.map((g) => [`${g.metric}|${g.periodStart}`, g.value]));
};

const goalsFor = (map, periodStart) => {
  const out = {};
  for (const m of METRICS) out[m] = map.get(`${m}|${periodStart}`) ?? null;
  return out;
};

// @route GET /api/goals?periodType=day|week|month&date=YYYY-MM-DD
// The goals stored for the period containing `date` (null = not set).
export const getGoals = async (req, res) => {
  if (deny(req, res)) return;
  try {
    const periodType = PERIOD_TYPES.includes(req.query.periodType) ? req.query.periodType : 'month';
    const p = periodOf(periodType, anchorOf(req.query.date));
    const map = await goalMap(periodType, [p.start]);
    res.json({
      periodType,
      periodStart: p.start,
      periodEnd: p.end,
      goals: goalsFor(map, p.start),
      canEdit: canSetGoals(req.user),
    });
  } catch (error) {
    sendError(res, error);
  }
};

// @route PUT /api/goals   { periodType, date, goals: { leads, bookings, revenue, trials } }
// A number sets the goal; null / '' clears it. Other periods are never touched.
export const saveGoals = async (req, res) => {
  if (!canSetGoals(req.user)) {
    return res.status(403).json({ message: 'Only admin, manager, sales or marketing managers can set goals' });
  }
  try {
    const { periodType, goals } = req.body || {};
    const p = periodOf(periodType, parseDayParam(req.body?.date));
    if (!p) return res.status(400).json({ message: 'A valid periodType (day, week, month) and date are required' });
    if (!goals || typeof goals !== 'object') return res.status(400).json({ message: 'goals is required' });

    const ops = [];
    for (const metric of METRICS) {
      if (!(metric in goals)) continue;
      const raw = goals[metric];
      const key = { metric, periodType, periodStart: p.start };
      if (raw === null || raw === '') {
        ops.push({ deleteOne: { filter: key } });
        continue;
      }
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) {
        return res.status(400).json({ message: `${metric} goal must be a number of 0 or more` });
      }
      ops.push({
        updateOne: { filter: key, update: { $set: { value, setBy: req.user._id } }, upsert: true },
      });
    }
    if (ops.length) await Goal.bulkWrite(ops);

    const map = await goalMap(periodType, [p.start]);
    res.json({ periodType, periodStart: p.start, goals: goalsFor(map, p.start) });
  } catch (error) {
    sendError(res, error);
  }
};

const LABELS = { leads: 'Leads', bookings: 'Bookings', revenue: 'Revenue', trials: 'Trial bookings' };

// @route GET /api/goals/report?granularity=day|week|month&date=&basis=added|event
// The period containing `date`: Target vs Actual per metric, plus a row per day
// (whose sum is the period total — they cannot disagree).
export const getGoalReport = async (req, res) => {
  if (deny(req, res)) return;
  try {
    const granularity = PERIOD_TYPES.includes(req.query.granularity) ? req.query.granularity : 'day';
    const basis = basisOf(req.query);
    const p = periodOf(granularity, anchorOf(req.query.date));

    const [byDay, periodGoals, dayGoals] = await Promise.all([
      actualsByDay(req.user, p.start, p.end, basis),
      goalMap(granularity, [p.start]),
      granularity === 'day' ? Promise.resolve(new Map()) : goalMap('day', p.days),
    ]);

    const days = fillDays(p.days, byDay);
    const totals = sumDays(days);
    const target = goalsFor(periodGoals, p.start);

    res.json({
      granularity,
      basis,
      period: { start: p.start, end: p.end, days: p.days.length },
      metrics: METRICS.map((key) => ({
        key,
        label: LABELS[key],
        actual: totals[key],
        target: target[key],
        pct: pct(totals[key], target[key] ?? 0),
      })),
      days: days.map((d) => ({ ...d, targets: granularity === 'day' ? target : goalsFor(dayGoals, d.day) })),
      canEdit: canSetGoals(req.user),
    });
  } catch (error) {
    sendError(res, error);
  }
};

// @route GET /api/goals/mtd?date=&basis=
// Month-to-date for the month containing `date` (default today): what has been
// achieved from the 1st to that day, the month goal, the goal pro-rated to that
// day, and the ratio achieved ÷ pro-rated.
export const getMtd = async (req, res) => {
  if (deny(req, res)) return;
  try {
    const basis = basisOf(req.query);
    const day = anchorOf(req.query.date);
    const month = periodOf('month', day);
    const upTo = day > month.end ? month.end : day;
    const dayOfMonth = Number(upTo.slice(8));
    const daysInMonth = month.days.length;

    const [byDay, goals] = await Promise.all([
      actualsByDay(req.user, month.start, upTo, basis),
      goalMap('month', [month.start]),
    ]);
    const achieved = sumDays(fillDays(month.days.filter((d) => d <= upTo), byDay));
    const target = goalsFor(goals, month.start);

    res.json({
      basis,
      month: month.start.slice(0, 7),
      asOf: upTo,
      dayOfMonth,
      daysInMonth,
      method: 'Pro-rated: month goal × days elapsed ÷ days in month. Ratio = achieved ÷ pro-rated goal.',
      metrics: METRICS.map((key) => ({
        key,
        label: LABELS[key],
        ...mtdFigures({ achieved: achieved[key], goal: target[key] ?? 0, dayOfMonth, daysInMonth }),
      })),
    });
  } catch (error) {
    sendError(res, error);
  }
};
