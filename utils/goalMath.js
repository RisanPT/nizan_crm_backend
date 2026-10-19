// Pure helpers for the Goals / Day-wise report (unit-tested, no database).
import { addDays, isDay, istMonthBounds, istWeekStart } from './istDate.js';

export const METRICS = ['leads', 'bookings', 'revenue', 'trials'];
export const PERIOD_TYPES = ['day', 'week', 'month'];

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export const emptyDay = () => ({ leads: 0, bookings: 0, revenue: 0, trials: 0 });

/// Every 'YYYY-MM-DD' from..to inclusive.
export const daysBetween = (from, to) => {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
};

/// The period (day / Monday-start week / calendar month, all IST) containing
/// `anchorDay`: { periodType, start, end, days: [...] }. null if invalid.
export const periodOf = (periodType, anchorDay) => {
  if (!PERIOD_TYPES.includes(periodType) || !isDay(anchorDay)) return null;
  let start;
  let end;
  if (periodType === 'day') {
    start = anchorDay;
    end = anchorDay;
  } else if (periodType === 'week') {
    start = istWeekStart(anchorDay);
    end = addDays(start, 6);
  } else {
    const [y, m] = anchorDay.split('-').map(Number);
    ({ from: start, to: end } = istMonthBounds(y, m));
  }
  return { periodType, start, end, days: daysBetween(start, end) };
};

/// Sum of the metric columns over day rows (each row is { leads, … }).
export const sumDays = (rows) => {
  const t = emptyDay();
  for (const r of rows) for (const k of METRICS) t[k] += Number(r?.[k]) || 0;
  t.revenue = round2(t.revenue);
  return t;
};

/// Per-day actuals for every day in `days` (days with no activity are zeros),
/// so a period's total is by construction the sum of its days.
export const fillDays = (days, byDay) =>
  days.map((day) => ({ day, ...emptyDay(), ...(byDay.get(day) || {}) }));

export const pct = (actual, target) =>
  target > 0 ? round2((actual / target) * 100) : null;

/// Month-to-date figures for one metric.
///  • achieved   = sum of actuals from the 1st to `dayOfMonth`
///  • proRated   = goal × dayOfMonth ÷ daysInMonth (what should be done by now)
///  • ratioPct   = achieved ÷ proRated  (the headline number)
///  • monthPct   = achieved ÷ full-month goal
/// status: no_goal | on_track (≥100%) | slightly_behind (≥80%) | behind
export const mtdFigures = ({ achieved, goal, dayOfMonth, daysInMonth }) => {
  const a = round2(achieved);
  const g = round2(goal);
  if (!(g > 0)) {
    return { achieved: a, goal: 0, proRatedGoal: 0, ratioPct: null, monthPct: null, status: 'no_goal' };
  }
  const proRated = round2((g * dayOfMonth) / daysInMonth);
  const ratioPct = pct(a, proRated);
  const status = ratioPct >= 100 ? 'on_track' : ratioPct >= 80 ? 'slightly_behind' : 'behind';
  return { achieved: a, goal: g, proRatedGoal: proRated, ratioPct, monthPct: pct(a, g), status };
};
