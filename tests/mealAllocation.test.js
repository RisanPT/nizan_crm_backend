// Pure unit tests (no database, no network): node --test tests/mealAllocation.test.js
//
// The day used throughout (IST, 30 Oct 2026) — the example the Accounts team gave:
//   Asha   08:00–11:00      Beena  13:00–16:00      Chitra  18:00–21:00
import test from 'node:test';
import assert from 'node:assert/strict';
import { placeMeal, placeMeals, allocateArtistDay, minutesFromWork, pickWork, istClock, cleanMeal, cleanMeals, canonicalMeals, mealsOf, singleMeal, mealsText, lastWorkOf, mealDayKey, workPeriod, periodOfClock, mealPeriod, FAR_MINUTES } from '../utils/mealAllocation.js';

const t = (hh, mm = 0, day = '2026-10-30') => new Date(`${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+05:30`);
const work = (id, from, to) => ({ id, serviceStart: t(from), serviceEnd: t(to) });
const DAY = [work('asha', 8, 11), work('beena', 13, 16), work('chitra', 18, 21)];
const meal = (id, hh, mm, name, amount, extra = {}) => ({ id, amount, category: 'food', meal: name, at: t(hh, mm), bookingId: null, workType: 'bridal', ...extra });

test('the worked example: breakfast → the morning work, lunch → the afternoon work, dinner → the evening work', () => {
  const where = (hh, mm, name) => placeMeal({ at: t(hh, mm), meal: name, works: DAY });
  assert.deepEqual(['breakfast 7:15', where(7, 15, 'breakfast').workId, where(7, 15, 'breakfast').relation, where(7, 15, 'breakfast').minutes], ['breakfast 7:15', 'asha', 'before', 45]);
  assert.deepEqual([where(11, 15, 'snacks').workId, where(11, 15, 'snacks').relation, where(11, 15, 'snacks').minutes], ['asha', 'after', 15]); // 15 min after Asha vs 1h45 before Beena
  assert.deepEqual([where(13, 30, 'lunch').workId, where(13, 30, 'lunch').relation, where(13, 30, 'lunch').minutes], ['beena', 'during', 0]);
  assert.deepEqual([where(16, 45, 'snacks').workId, where(16, 45, 'snacks').minutes], ['beena', 45]); // 45 min after Beena vs 75 before Chitra
  assert.deepEqual([where(21, 30, 'dinner').workId, where(21, 30, 'dinner').relation, where(21, 30, 'dinner').minutes], ['chitra', 'after', 30]);
});

test('the day\'s food adds up under each work: Asha 150, Beena 230, Chitra 180', () => {
  const r = allocateArtistDay({
    works: DAY,
    expenses: [
      meal('e1', 7, 15, 'breakfast', 120),
      meal('e2', 11, 15, 'snacks', 30),
      meal('e3', 13, 30, 'lunch', 200),
      meal('e4', 16, 45, 'snacks', 30),
      meal('e5', 21, 30, 'dinner', 180),
    ],
  });
  assert.equal(r.perWork.asha.food, 150);
  assert.equal(r.perWork.beena.food, 230);
  assert.equal(r.perWork.chitra.food, 180);
  assert.equal(r.perWork.asha.total, 150);
  assert.deepEqual([...r.lines.values()].map((l) => l.mode), ['time', 'time', 'time', 'time', 'time']);
  assert.equal(r.unallocated, 0);
});

test('a meal goes by the TIME OF DAY: lunch is under the afternoon work even when it is eaten right after the morning one', () => {
  // Asha is a morning work (8–11), Beena an afternoon one (1–4). Lunch at 11:30 — 30 min after Asha ended,
  // 90 min before Beena starts — still belongs to the afternoon work.
  const lunch = placeMeal({ at: t(11, 30), meal: 'lunch', works: DAY });
  assert.equal(lunch.workId, 'beena');
  assert.equal(lunch.basis, 'period');
  assert.equal(lunch.period, 'afternoon');
  // …and breakfast eaten late, after the morning work, is still the morning work's.
  assert.equal(placeMeal({ at: t(12, 30), meal: 'breakfast', works: DAY }).workId, 'asha');
  // dinner before the evening work starts is the evening work's, not the afternoon one's.
  assert.equal(placeMeal({ at: t(17, 15), meal: 'dinner', works: DAY }).workId, 'chitra');
});

test('snacks / tea have no fixed period: the clock decides', () => {
  assert.equal(placeMeal({ at: t(10, 30), meal: 'snacks', works: DAY }).workId, 'asha'); // morning tea
  assert.equal(placeMeal({ at: t(15, 0), meal: 'snacks', works: DAY }).workId, 'beena'); // afternoon tea
  assert.equal(placeMeal({ at: t(17, 30), meal: 'snacks', works: DAY }).workId, 'chitra'); // evening tea
  assert.equal(mealPeriod('snacks', t(10, 30)), 'morning');
  assert.equal(mealPeriod('snacks', t(17, 0)), 'evening');
});

test('several works of that period: the nearest one; a tie goes to the LATER, and the reason says so', () => {
  const works = [work('m1', 7, 8), work('m2', 10, 11), work('aft', 14, 16)];
  const p = placeMeal({ at: t(9, 30), meal: 'breakfast', works }); // m1 ended 90 min ago, m2 starts in 30
  assert.equal(p.workId, 'm2');
  assert.match(p.reason, /Nearest of the 2 morning works\.$/);
  const tie = placeMeal({ at: t(9, 0), meal: 'breakfast', works });
  assert.equal(tie.workId, 'm2');
  assert.match(tie.reason, /equally close — the later one is used/);
});

test('no work of the meal\'s period that day: the nearest work, and the reason says so (a tie goes to the later work)', () => {
  const works = [work('am', 8, 10), work('eve', 18, 20)]; // no afternoon work
  const p = placeMeal({ at: t(14), meal: 'lunch', works }); // 4 h after am, 4 h before eve
  assert.equal(p.workId, 'eve');
  assert.equal(p.basis, 'nearest');
  assert.match(p.reason, /^Lunch at 2:00 PM — no afternoon work that day, so the nearest work \(4 h before this work starts\)\. Equally close to another work; the later one is used\.$/);
  const near = placeMeal({ at: t(12), meal: 'lunch', works });
  assert.equal(near.workId, 'am'); // 2 h after am vs 6 h before eve
  assert.equal(near.basis, 'nearest');
});

test('work periods: by the middle of the work', () => {
  assert.equal(workPeriod(work('w', 8, 11)), 'morning');
  assert.equal(workPeriod(work('w', 13, 16)), 'afternoon');
  assert.equal(workPeriod(work('w', 18, 21)), 'evening');
  assert.equal(workPeriod(work('w', 11, 14)), 'afternoon', 'middle 12:30');
  assert.equal(workPeriod(work('w', 6, 12)), 'morning', 'middle 9:00');
  assert.equal(workPeriod(work('w', 15, 19)), 'evening', 'middle 17:00');
  assert.equal(workPeriod({ id: 'p', serviceStart: t(9) }), 'morning', 'no end: the start');
  assert.deepEqual([periodOfClock(11 * 60 + 59), periodOfClock(12 * 60), periodOfClock(16 * 60 + 59), periodOfClock(17 * 60)], ['morning', 'afternoon', 'afternoon', 'evening']);
  assert.deepEqual([mealPeriod('breakfast', t(15)), mealPeriod('lunch', t(8)), mealPeriod('dinner', t(8))], ['morning', 'afternoon', 'evening']);
});

test('one work that day takes all the food, however far the meal is', () => {
  const p = placeMeal({ at: t(23), meal: 'dinner', works: [work('only', 8, 10)] });
  assert.deepEqual([p.mode, p.workId, p.flag, p.reason], ['single', 'only', '', 'The only work that day.']);
});

test('no work that day: unallocated, never forced onto something', () => {
  const p = placeMeal({ at: t(13), meal: 'lunch', works: [] });
  assert.deepEqual([p.mode, p.workId], ['unallocated', null]);
  const r = allocateArtistDay({ works: [], expenses: [meal('e1', 13, 0, 'lunch', 200)] });
  assert.equal(r.unallocated, 200);
  assert.equal(r.lines.get('e1').mode, 'unallocated');
  assert.deepEqual(r.lines.get('e1').shares, []);
});

test('a meal more than 4 hours from the nearest work is flagged "far"', () => {
  const works = [work('a', 6, 8), work('b', 22, 23)];
  const p = placeMeal({ at: t(14), meal: 'lunch', works }); // 6 h after a, 8 h before b
  assert.equal(p.workId, 'a');
  assert.equal(p.flag, 'far');
  assert.ok(p.minutes > FAR_MINUTES);
  assert.equal(placeMeal({ at: t(12), meal: 'lunch', works }).flag, '', '4 h exactly is not far');
});

test('the reasons read like a person wrote them', () => {
  assert.equal(placeMeal({ at: t(7, 15), meal: 'breakfast', works: DAY }).reason, 'Breakfast at 7:15 AM — under the morning work.');
  assert.equal(placeMeal({ at: t(13, 30), meal: 'lunch', works: DAY }).reason, 'Lunch at 1:30 PM — under the afternoon work.');
  assert.equal(placeMeal({ at: t(21, 30), meal: 'dinner', works: DAY }).reason, 'Dinner at 9:30 PM — under the evening work.');
  assert.equal(placeMeal({ at: t(16, 45), meal: 'snacks', works: DAY }).reason, 'Snacks at 4:45 PM — under the afternoon work.');
  assert.match(placeMeal({ at: t(6, 0), meal: 'breakfast', works: [work('a', 14, 15), work('b', 18, 19)] }).reason, /^Breakfast at 6:00 AM — no morning work that day, so the nearest work \(8 h before this work starts\)\.$/);
});

test('a work the artist chose always wins over the time rule — even one that is no longer on that day', () => {
  const r = allocateArtistDay({ works: DAY, expenses: [meal('e1', 13, 30, 'lunch', 200, { bookingId: 'chitra' }), meal('e2', 8, 0, 'breakfast', 90, { bookingId: 'moved-away' })] });
  assert.deepEqual([r.lines.get('e1').mode, r.lines.get('e1').shares], ['pinned', [{ bookingId: 'chitra', amount: 200 }]]);
  assert.equal(r.lines.get('e2').mode, 'pinned');
  assert.equal(r.perWork['moved-away'].food, 90);
  assert.equal(r.perWork.chitra.food, 200);
  assert.equal(r.perWork.beena, undefined, 'nothing was left for the work the time rule would have picked');
});

test('older food with no meal recorded is left alone: not split, not guessed at', () => {
  const old = { id: 'old', amount: 100, category: 'food', meal: '', at: t(13), bookingId: null, workType: 'bridal' };
  const r = allocateArtistDay({ works: DAY, expenses: [old] });
  assert.equal(r.lines.get('old').mode, 'unlinked');
  assert.deepEqual(r.lines.get('old').shares, []);
  assert.deepEqual(r.perWork, {});
  assert.equal(r.unlinked, 100);
  assert.equal(r.lines.get('old').reason, 'No meal recorded — not placed under a work.');
  // …unless the artist tied it to a work
  const pinned = allocateArtistDay({ works: DAY, expenses: [{ ...old, bookingId: 'beena' }] });
  assert.equal(pinned.lines.get('old').mode, 'pinned');
  assert.equal(pinned.perWork.beena.food, 100);
  // the same on a day with no works: still just "unlinked" (it was never going to be placed)
  assert.equal(allocateArtistDay({ works: [], expenses: [old] }).lines.get('old').mode, 'unlinked');
});

test('only food is placed by time: other spend is direct when tied, otherwise "unlinked"', () => {
  const r = allocateArtistDay({
    works: DAY,
    expenses: [
      { id: 'cab', amount: 400, category: 'travel', meal: '', at: t(9), bookingId: 'asha', workType: 'bridal' },
      { id: 'kit', amount: 250, category: 'materials', meal: '', at: t(9), bookingId: null, workType: 'bridal' },
    ],
  });
  assert.equal(r.lines.get('cab').mode, 'direct');
  assert.deepEqual([r.perWork.asha.other, r.perWork.asha.food, r.perWork.asha.byCategory.travel], [400, 0, 400]);
  assert.equal(r.lines.get('kit').mode, 'unlinked');
  assert.equal(r.unlinked, 250);
});

test('a model shoot is never put under a client\'s work', () => {
  const r = allocateArtistDay({ works: DAY, expenses: [meal('s1', 13, 30, 'lunch', 300, { workType: 'model_shoot' })] });
  assert.equal(r.lines.get('s1').mode, 'shoot');
  assert.deepEqual(r.perWork, {});
  assert.equal(r.unlinked, 300);
});

test('paise: amounts are carried exactly, with no floating-point drift', () => {
  const r = allocateArtistDay({ works: DAY, expenses: [meal('a', 7, 0, 'breakfast', 99.99), meal('b', 13, 30, 'lunch', 0.01), meal('c', 8, 0, 'breakfast', 12.34)] });
  assert.equal(r.perWork.asha.food, 112.33);
  assert.equal(r.perWork.beena.food, 0.01);
});

test('minutesFromWork: during, before, after — and a work whose end is missing or before its start is a point in time', () => {
  assert.deepEqual(minutesFromWork(t(9), work('x', 8, 11)), { minutes: 0, relation: 'during' });
  assert.deepEqual(minutesFromWork(t(7), work('x', 8, 11)), { minutes: 60, relation: 'before' });
  assert.deepEqual(minutesFromWork(t(12), work('x', 8, 11)), { minutes: 60, relation: 'after' });
  assert.deepEqual(minutesFromWork(t(9), { id: 'p', serviceStart: t(8) }), { minutes: 60, relation: 'after' });
  assert.deepEqual(minutesFromWork(t(9), { id: 'p', serviceStart: t(8), serviceEnd: t(7) }), { minutes: 60, relation: 'after' });
});

test('pickWork is stable whatever order the works come in', () => {
  const a = pickWork(t(12), [DAY[2], DAY[0], DAY[1]]);
  const b = pickWork(t(12), DAY);
  assert.equal(a.work.id, b.work.id);
  assert.equal(pickWork(t(12), []), null);
});

test('clock times are in IST, 12-hour', () => {
  assert.equal(istClock(t(0, 5)), '12:05 AM');
  assert.equal(istClock(t(12, 0)), '12:00 PM');
  assert.equal(istClock(t(13, 30)), '1:30 PM');
  assert.equal(istClock(t(23, 59)), '11:59 PM');
});

test('a meal belongs to the IST day of its time (the day a work starts is its day)', () => {
  assert.equal(mealDayKey(t(23, 30)), '2026-10-30');
  assert.equal(mealDayKey(t(0, 30, '2026-10-31')), '2026-10-31');
  assert.equal(mealDayKey(new Date('2026-10-30T19:00:00Z')), '2026-10-31', '00:30 IST next day');
});

test('only food keeps a meal; unknown meals are dropped', () => {
  assert.equal(cleanMeal('lunch', 'food'), 'lunch');
  assert.equal(cleanMeal('lunch', 'travel'), '');
  assert.equal(cleanMeal('brunch', 'food'), '');
  assert.equal(cleanMeal(undefined, 'food'), '');
});

// ── one entry covering SEVERAL meals (a long trip: breakfast + lunch + dinner on one bill) ──────────
const combo = (id, hh, mm, meals, amount, extra = {}) => ({ id, amount, category: 'food', meal: singleMeal(meals), meals, at: t(hh, mm), bookingId: null, workType: 'bridal', ...extra });

test('meals are cleaned: only food, only real meals, each once, in the order of the day', () => {
  assert.deepEqual(cleanMeals(['dinner', 'breakfast', 'lunch', 'breakfast', 'brunch', ''], 'food'), ['breakfast', 'lunch', 'dinner']);
  assert.deepEqual(cleanMeals('lunch,dinner', 'food'), ['lunch', 'dinner'], 'a comma list works too');
  assert.deepEqual(cleanMeals(['lunch'], 'travel'), [], 'a meal means nothing on a travel expense');
  assert.deepEqual(cleanMeals(undefined, 'food'), []);
  assert.deepEqual(canonicalMeals(' dinner , breakfast'), ['breakfast', 'dinner'], 'spaces are ignored');
});

test('mealsOf reads `meals`, else the old single `meal`, else none; singleMeal is only set for exactly one', () => {
  assert.deepEqual(mealsOf({ meals: ['lunch', 'dinner'], meal: '' }), ['lunch', 'dinner']);
  assert.deepEqual(mealsOf({ meals: [], meal: 'lunch' }), ['lunch'], 'an older entry');
  assert.deepEqual(mealsOf({ meal: 'lunch' }), ['lunch']);
  assert.deepEqual(mealsOf({ meals: [], meal: '' }), []);
  assert.deepEqual(mealsOf({}), []);
  assert.equal(singleMeal(['lunch']), 'lunch');
  assert.equal(singleMeal(['lunch', 'dinner']), '');
  assert.equal(singleMeal([]), '');
  assert.equal(mealsText(['breakfast', 'lunch', 'dinner']), 'breakfast, lunch and dinner');
  assert.equal(mealsText(['lunch', 'dinner']), 'lunch and dinner');
});

test('several meals, ONE work that day: the work takes all of it', () => {
  const p = placeMeals({ at: t(22, 0), meals: ['breakfast', 'lunch', 'dinner'], works: [work('wedding', 17, 21)] });
  assert.deepEqual([p.mode, p.basis, p.workId, p.flag], ['single', 'only', 'wedding', '']);
  assert.equal(p.reason, 'The only work that day.');
});

test('several meals, SEVERAL works that day: the LAST work of the day takes it', () => {
  const p = placeMeals({ at: t(14, 0), meals: ['breakfast', 'lunch', 'dinner'], works: DAY });
  assert.deepEqual([p.mode, p.basis, p.workId, p.flag], ['last', 'last', 'chitra', '']);
  assert.equal(p.reason, 'Breakfast, lunch and dinner in one entry — counted under the last work of the day.');
  // the time of the bill does not matter — not even a bill before the first work
  assert.equal(placeMeals({ at: t(5, 0), meals: ['breakfast', 'dinner'], works: DAY }).workId, 'chitra');
  // and the order the works arrive in does not matter
  assert.equal(placeMeals({ at: t(14, 0), meals: ['lunch', 'dinner'], works: [...DAY].reverse() }).workId, 'chitra');
});

test('"last" is the work that STARTS last (a tie: the one that ends last)', () => {
  assert.equal(lastWorkOf([work('a', 9, 12), work('b', 9, 18), work('c', 8, 20)]).id, 'b');
  assert.equal(lastWorkOf([work('a', 9, 12)]).id, 'a');
});

test('several meals, NO work that day: unallocated', () => {
  const p = placeMeals({ at: t(14), meals: ['lunch', 'dinner'], works: [] });
  assert.deepEqual([p.mode, p.workId], ['unallocated', null]);
});

test('ONE meal (even sent as a list) still follows the time-of-day rules, not "last"', () => {
  const p = placeMeals({ at: t(13, 30), meals: ['lunch'], works: DAY });
  assert.deepEqual([p.mode, p.basis, p.workId], ['time', 'period', 'beena']);
  assert.deepEqual(placeMeals({ at: t(13, 30), meals: ['lunch'], works: DAY }), placeMeal({ at: t(13, 30), meal: 'lunch', works: DAY }));
});

test('a day: a combined bill goes to the last work, the single meals keep their own works', () => {
  const r = allocateArtistDay({
    works: DAY,
    expenses: [
      meal('b', 7, 30, 'breakfast', 100), // morning work
      combo('trip', 14, 0, ['lunch', 'dinner'], 500), // combined → the last work
    ],
  });
  assert.equal(r.lines.get('b').shares[0].bookingId, 'asha');
  const trip = r.lines.get('trip');
  assert.deepEqual([trip.mode, trip.basis, trip.shares], ['last', 'last', [{ bookingId: 'chitra', amount: 500 }]]);
  assert.equal(r.perWork.chitra.food, 500);
  assert.equal(r.perWork.asha.food, 100);
});

test('a combined bill the artist PINNED to a work stays on that work', () => {
  const r = allocateArtistDay({ works: DAY, expenses: [combo('trip', 14, 0, ['lunch', 'dinner'], 500, { bookingId: 'beena' })] });
  assert.deepEqual([r.lines.get('trip').mode, r.lines.get('trip').shares[0].bookingId], ['pinned', 'beena']);
});

test('a combined bill on a day with one work, none, or a model shoot', () => {
  assert.equal(allocateArtistDay({ works: [work('only', 17, 21)], expenses: [combo('c', 8, 0, ['breakfast', 'lunch', 'dinner'], 450)] }).lines.get('c').mode, 'single');
  const none = allocateArtistDay({ works: [], expenses: [combo('c', 8, 0, ['breakfast', 'lunch'], 300)] });
  assert.deepEqual([none.lines.get('c').mode, none.unallocated], ['unallocated', 300]);
  assert.equal(allocateArtistDay({ works: DAY, expenses: [combo('c', 8, 0, ['lunch', 'dinner'], 300, { workType: 'model_shoot' })] }).lines.get('c').mode, 'shoot');
});

test('an old entry (only `meal`) and an entry with no meal at all behave as before', () => {
  const old = { id: 'old', amount: 90, category: 'food', meal: 'lunch', at: t(13, 30), bookingId: null, workType: 'bridal' };
  assert.equal(allocateArtistDay({ works: DAY, expenses: [old] }).lines.get('old').mode, 'time');
  const nothing = { id: 'n', amount: 90, category: 'food', meal: '', meals: [], at: t(13, 30), bookingId: null, workType: 'bridal' };
  assert.equal(allocateArtistDay({ works: DAY, expenses: [nothing] }).lines.get('n').mode, 'unlinked');
});

test('paise stay exact for a combined bill', () => {
  const r = allocateArtistDay({ works: DAY, expenses: [combo('c', 14, 0, ['breakfast', 'lunch', 'dinner'], 1234.57)] });
  assert.equal(r.perWork.chitra.food, 1234.57);
});
