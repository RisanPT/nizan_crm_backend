// An artist's day expenses, put "under the works" they belong to — above all FOOD,
// which is charged to the work it was eaten for, by time.
//
// Rules (the Accounts team asked for this; one rule, easy to explain):
//   • Food the artist tied to a work               → that work (pinned — always wins).
//   • Food with a meal + time, bridal work         → by the TIME OF DAY of the meal and of the works:
//        – a work is a MORNING work (its middle is before 12:00), an AFTERNOON work (12:00–17:00)
//          or an EVENING work (after 17:00). Breakfast belongs to the morning work, lunch to the
//          afternoon work, dinner to the evening work; snacks / tea to the work of the period the
//          clock says (before 12 morning, 12–5 afternoon, after 5 evening).
//        – several works of that period → the one NEAREST in time to the meal (during a work = 0
//          minutes away; before / after it = minutes to its start / since its end). Tie → the LATER work.
//        – no work of that period that day → the nearest work of the day, and the reason says so.
//        – only one work that day → it takes all the food; no work that day → unallocated.
//        – further than 4 h from the work chosen → flagged "far" for Accounts to check.
//   • ONE entry covering SEVERAL meals (a long trip: breakfast, lunch and dinner on one bill)
//     → the only work that day, or — with several works — the LAST work of the day (mode 'last').
//     A work the artist pinned still wins. One-meal entries follow the time-of-day rules above.
//   • Food with NO meal recorded (older entries)    → left as it is: not split, not guessed at
//     ("unlinked"), unless the artist tied it to a work.
//   • Other categories tied to a work               → that work; not tied → "unlinked"
//     (only food is placed by time).
//   • Model-shoot spend                             → never put under a client's work.
//
// Nothing is stored: allocations are computed on read from the artist's CURRENT works
// for that day, so a work that is added, moved or cancelled moves the meals with it.
// Money is split in paise so shares always add back to the exact amount.
//
// Pure functions — tests/mealAllocation.test.js.

import { IST_OFFSET_MS, istDayKey } from './istDate.js';
import { toPaise, toRupees } from './expenseAllocation.js';

export const MEALS = ['breakfast', 'lunch', 'snacks', 'dinner'];
export const MEAL_LABEL = { breakfast: 'Breakfast', lunch: 'Lunch', snacks: 'Snacks', dinner: 'Dinner' };

/// A meal further than this from the nearest work is flagged for a second look.
export const FAR_MINUTES = 240;

/// The meal types a client may send, '' for none. Anything else is dropped.
export const cleanMeal = (value, category) => (category === 'food' && MEALS.includes(value) ? value : '');

/// The meals of a list (an array, or a comma-separated string) in the order of the day, each once.
/// Anything that is not a meal is dropped.
export const canonicalMeals = (value) => {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(',');
  const wanted = new Set(raw.map((m) => String(m).trim()));
  return MEALS.filter((m) => wanted.has(m));
};

/// What a client sent for the meals of a FOOD entry, cleaned: one entry may cover several meals
/// (breakfast + lunch + dinner on a long trip, one bill). [] for anything that is not food.
export const cleanMeals = (value, category) => (category === 'food' ? canonicalMeals(value) : []);

/// The meals an expense covers: its `meals`, else (older entries) its single `meal`, else none.
export const mealsOf = (e) => {
  const list = canonicalMeals(e?.meals);
  if (list.length > 0) return list;
  return MEALS.includes(e?.meal) ? [e.meal] : [];
};

/// What goes in the single `meal` field next to `meals`: the meal when there is exactly one, else ''
/// (a combined entry belongs to no ONE meal — so anything that only knows `meal` leaves it alone).
export const singleMeal = (list) => (list.length === 1 ? list[0] : '');

/// "breakfast, lunch and dinner" — for sentences.
export const mealsText = (list) => {
  const names = list.map((m) => (MEAL_LABEL[m] ?? m).toLowerCase());
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
};

/// The IST calendar day a meal belongs to — the day of its time. (A work counts on the day
/// it STARTS, so a meal after midnight belongs to the next day's works.)
export const mealDayKey = (at) => istDayKey(at);

export const PERIOD_LABEL = { morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening' };

// Breakfast is a morning meal, lunch an afternoon one, dinner an evening one. Snacks / tea
// have no fixed period: the clock decides.
const MEAL_PERIOD = { breakfast: 'morning', lunch: 'afternoon', dinner: 'evening' };

const istMinutesOfDay = (ms) => {
  const d = new Date(ms + IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

/// morning (before 12:00) · afternoon (12:00 – 17:00) · evening (17:00 on), for a minute of the IST day.
export const periodOfClock = (minutes) => (minutes < 12 * 60 ? 'morning' : minutes < 17 * 60 ? 'afternoon' : 'evening');

/// When in the day a work is: by the middle of it ("8–11" is a morning work, "11–2" an afternoon one).
export const workPeriod = (work) => {
  const start = new Date(work.serviceStart).getTime();
  const end = Math.max(start, new Date(work.serviceEnd ?? work.serviceStart).getTime());
  return periodOfClock(istMinutesOfDay((start + end) / 2));
};

/// The period a meal belongs to.
export const mealPeriod = (meal, at) => MEAL_PERIOD[meal] ?? periodOfClock(istMinutesOfDay(new Date(at).getTime()));

/// "1:30 PM" — the IST clock time of an instant.
export const istClock = (at) => {
  const d = new Date(new Date(at).getTime() + IST_OFFSET_MS);
  const h = d.getUTCHours();
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? 'AM' : 'PM'}`;
};

const fmtMinutes = (min) => {
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  return m % 60 === 0 ? `${m / 60} h` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

/// How far the meal is from a work: 0 during it, else minutes to its start / since its end.
export const minutesFromWork = (at, work) => {
  const t = new Date(at).getTime();
  const start = new Date(work.serviceStart).getTime();
  const end = Math.max(start, new Date(work.serviceEnd ?? work.serviceStart).getTime());
  if (t < start) return { minutes: (start - t) / 60000, relation: 'before' };
  if (t > end) return { minutes: (t - end) / 60000, relation: 'after' };
  return { minutes: 0, relation: 'during' };
};

/// The nearest work to a meal. Tie → the later work. null when there are no works.
/// @returns {{ work, minutes, relation, tie: boolean, only: boolean } | null}
export const pickWork = (at, works) => {
  if (!works?.length) return null;
  const rated = works.map((w) => ({ work: w, ...minutesFromWork(at, w) }));
  rated.sort(
    (a, b) =>
      a.minutes - b.minutes ||
      new Date(b.work.serviceStart) - new Date(a.work.serviceStart) || // later work first on a tie
      String(b.work.id).localeCompare(String(a.work.id)),
  );
  const best = rated[0];
  return { ...best, tie: rated.length > 1 && rated[1].minutes === best.minutes, only: rated.length === 1 };
};

const whenText = (pick) =>
  pick.relation === 'during'
    ? 'during this work'
    : pick.relation === 'before'
      ? `${fmtMinutes(pick.minutes)} before this work starts`
      : `${fmtMinutes(pick.minutes)} after this work ended`;

/**
 * Which work does ONE meal belong to? (Used for the artist's preview and by allocateArtistDay.)
 * @param {object} o  { at, meal, works: [{ id, serviceStart, serviceEnd }] }
 * @returns {{ mode: 'time'|'single'|'unallocated', basis: 'only'|'period'|'nearest'|'', workId: string|null,
 *             minutes, relation, period, flag: ''|'far', reason }}
 *   basis  period   = the work of the meal's period (breakfast → morning work …)
 *          nearest  = no work of that period that day, so the nearest work
 *          only     = the only work that day
 */
export const placeMeal = ({ at, meal, works }) => {
  if (!works?.length) {
    return { mode: 'unallocated', basis: '', workId: null, minutes: null, relation: '', period: mealPeriod(meal, at), flag: '', reason: 'No work on this day to put it under.' };
  }
  const label = MEAL_LABEL[meal] ?? 'Meal';
  const wanted = mealPeriod(meal, at);
  const only = works.length === 1;
  const sameKind = only ? [] : works.filter((w) => workPeriod(w) === wanted);
  const byPeriod = sameKind.length > 0;
  const pick = pickWork(at, byPeriod ? sameKind : works);

  let reason;
  if (only) {
    reason = 'The only work that day.';
  } else if (byPeriod) {
    reason = `${label} at ${istClock(at)} — under the ${wanted} work.`;
    if (sameKind.length > 1) {
      reason += ` Nearest of the ${sameKind.length} ${wanted} works${pick.tie ? ' (equally close — the later one is used)' : ''}.`;
    }
  } else {
    reason = `${label} at ${istClock(at)} — no ${wanted} work that day, so the nearest work (${whenText(pick)}).${pick.tie ? ' Equally close to another work; the later one is used.' : ''}`;
  }

  return {
    mode: only ? 'single' : 'time',
    basis: only ? 'only' : byPeriod ? 'period' : 'nearest',
    workId: String(pick.work.id),
    minutes: Math.round(pick.minutes),
    relation: pick.relation,
    period: wanted,
    flag: !only && pick.minutes > FAR_MINUTES ? 'far' : '',
    reason,
  };
};

/// The last work of the day: the one that starts last (ties: ends last, then the later id).
export const lastWorkOf = (works) =>
  [...works].sort(
    (a, b) =>
      new Date(b.serviceStart) - new Date(a.serviceStart) ||
      new Date(b.serviceEnd ?? b.serviceStart) - new Date(a.serviceEnd ?? a.serviceStart) ||
      String(b.id).localeCompare(String(a.id)),
  )[0];

/**
 * Which work does ONE ENTRY belong to — one meal, or several in one bill (a long trip: breakfast,
 * lunch and dinner paid together)?
 *   • one meal            → placeMeal (by the time of day, above)
 *   • several meals       → ONE work that day: it takes everything; SEVERAL works that day: the LAST
 *                           work of the day (a combined bill has no single time to place it by);
 *                           no work that day: unallocated
 * Same result shape as placeMeal; mode 'last' / basis 'last' for the last-work case.
 */
export const placeMeals = ({ at, meals, works }) => {
  const list = canonicalMeals(meals);
  if (list.length <= 1) return placeMeal({ at, meal: list[0] ?? '', works });
  const period = mealPeriod('', at);
  if (!works?.length) {
    return { mode: 'unallocated', basis: '', workId: null, minutes: null, relation: '', period, flag: '', reason: 'No work on this day to put it under.' };
  }
  if (works.length === 1) {
    return { mode: 'single', basis: 'only', workId: String(works[0].id), minutes: null, relation: '', period, flag: '', reason: 'The only work that day.' };
  }
  const last = lastWorkOf(works);
  const text = mealsText(list);
  return {
    mode: 'last',
    basis: 'last',
    workId: String(last.id),
    minutes: null,
    relation: '',
    period,
    flag: '',
    reason: `${text.charAt(0).toUpperCase()}${text.slice(1)} in one entry — counted under the last work of the day.`,
  };
};

/**
 * One artist's day.
 * @param {object} o
 * @param {Array}  o.works     [{ id, serviceStart, serviceEnd }] — the day's works (cancelled excluded)
 * @param {Array}  o.expenses  [{ id, amount, category, meal, meals?, at, bookingId|null, workType }]
 * @returns {{ lines: Map<string, Line>, perWork: { [bookingId]: { total, food, other, byCategory } }, unallocated, unlinked }}
 *   Line: { mode: 'pinned'|'time'|'single'|'direct'|'unallocated'|'unlinked'|'shoot',
 *           shares: [{ bookingId, amount }], reason, flag, relation?, minutes? }
 */
export const allocateArtistDay = ({ works = [], expenses = [] }) => {
  const ids = works.map((w) => String(w.id));
  const lines = new Map();
  const per = new Map(); // bookingId → { foodPaise, otherPaise, byCategory }
  let unallocatedPaise = 0;
  let unlinkedPaise = 0;

  const put = (bookingId, category, paise) => {
    if (!per.has(bookingId)) per.set(bookingId, { foodPaise: 0, otherPaise: 0, byCategory: {} });
    const p = per.get(bookingId);
    if (category === 'food') p.foodPaise += paise;
    else p.otherPaise += paise;
    p.byCategory[category] = (p.byCategory[category] || 0) + paise;
  };

  for (const e of expenses) {
    const paise = toPaise(e.amount);
    const category = e.category || 'other';
    const link = e.bookingId ? String(e.bookingId) : null;
    const base = { shares: [], reason: '', flag: '' };
    const one = (mode, bookingId, extra = {}) => {
      put(bookingId, category, paise);
      lines.set(String(e.id), { ...base, mode, shares: [{ bookingId, amount: toRupees(paise) }], ...extra });
    };

    if (link) {
      one(category === 'food' ? 'pinned' : 'direct', link, { reason: 'Tied to this work.' });
    } else if (e.workType === 'model_shoot') {
      unlinkedPaise += paise;
      lines.set(String(e.id), { ...base, mode: 'shoot', reason: 'A model shoot — not put under a client work.' });
    } else if (category !== 'food') {
      unlinkedPaise += paise;
      lines.set(String(e.id), { ...base, mode: 'unlinked', reason: 'Not tied to a work.' });
    } else if (mealsOf(e).length === 0) {
      // An older entry (before meals were recorded): left alone rather than guessed at.
      unlinkedPaise += paise;
      lines.set(String(e.id), { ...base, mode: 'unlinked', reason: 'No meal recorded — not placed under a work.' });
    } else if (ids.length === 0) {
      unallocatedPaise += paise;
      lines.set(String(e.id), { ...base, mode: 'unallocated', reason: 'No work on this day to put it under.' });
    } else {
      const placed = placeMeals({ at: e.at, meals: mealsOf(e), works });
      one(placed.mode, placed.workId, { reason: placed.reason, flag: placed.flag, relation: placed.relation, minutes: placed.minutes, basis: placed.basis });
    }
  }

  const perWork = {};
  for (const [id, p] of per) {
    perWork[id] = {
      total: toRupees(p.foodPaise + p.otherPaise),
      food: toRupees(p.foodPaise),
      other: toRupees(p.otherPaise),
      byCategory: Object.fromEntries(Object.entries(p.byCategory).map(([c, v]) => [c, toRupees(v)])),
    };
  }
  return { lines, perWork, unallocated: toRupees(unallocatedPaise), unlinked: toRupees(unlinkedPaise) };
};
