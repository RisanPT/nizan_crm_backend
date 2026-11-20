// The CRM weekly report's figures (utils/crmWeekly.js): node --test tests/crmWeekly.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanTyped,
  clientKey,
  effectiveFigures,
  medicalFigures,
  missingForSubmit,
  overrideProblems,
  typedSetPaths,
  outsourceFigures,
  photosReviewsFigures,
  resolveWeek,
  supportFigures,
  verificationFigures,
  weekOf,
  workloadFigures,
} from '../utils/crmWeekly.js';
import { weeklySummaryRows } from '../services/crmWeeklyFiles.js';

const week = weekOf('2026-11-12'); // Mon 9 – Sun 15 Nov
const next = weekOf('2026-11-16');
const bk = (id, days, extra = {}) => ({ _id: id, status: 'confirmed', customerName: id.toUpperCase(), bookingNumber: `BN-${id}`, phone: '98950', selectedDates: days, ...extra });
const care = (map) => (id) => map[id] ?? null;

test('a week is Monday to Sunday; with none asked for, the last full week', () => {
  assert.deepEqual(week, { from: '2026-11-09', to: '2026-11-15', label: '9 Nov – 15 Nov 2026' });
  assert.deepEqual(resolveWeek('', '2026-11-18'), weekOf('2026-11-10'), 'Wednesday the 18th: last week is 9–15');
  assert.deepEqual(resolveWeek('2026-11-15', '2026-11-18').from, '2026-11-09', 'a Sunday is in the week that ends on it');
  assert.match(resolveWeek('15/11', '2026-11-18').error, /YYYY-MM-DD/);
});

test('photos and reviews: works done up to today; photos per work day, reviews per client', () => {
  const bookings = [bk('a', ['2026-11-10', '2026-11-11']), bk('b', ['2026-11-12']), bk('c', ['2026-11-14']), bk('d', ['2026-11-12'], { status: 'cancelled' })];
  const r = photosReviewsFigures({
    bookings,
    careOf: care({ a: { photos: [{ day: '2026-11-10' }, { day: '2026-11-11' }] }, b: { photos: [] } }),
    reviewed: new Set(['a']),
    week,
    today: '2026-11-13', // the 14th has not happened yet
  });
  assert.deepEqual([r.worksDone, r.photos, r.photosPct, r.clientsDone, r.reviews, r.reviewsPct], [3, 2, 66.7, 2, 1, 50]);
  assert.deepEqual(r.missingPhotos.map((m) => m.client), ['B']);
  assert.deepEqual(r.missingReviews.map((m) => m.client), ['B']);
  const before = photosReviewsFigures({ bookings, careOf: care({}), reviewed: new Set(), week, today: '2026-11-20', tracked: false });
  assert.deepEqual([before.worksDone, before.photos, before.missingPhotos.length], [4, null, 0], 'before the ticks began: "—", not 0');
});

test('customer support: different clients (one phone written two ways is one), and each member\'s', () => {
  const a = clientKey('+91 98950 11111');
  assert.equal(a, clientKey('9895011111'));
  assert.equal(clientKey('', 'chat:1'), 'x:chat:1');
  assert.equal(clientKey(''), '');
  const r = supportFigures([
    { client: a, by: 'u1', byName: 'Asha' },
    { client: clientKey('9895011111'), by: 'u1', byName: 'Asha' },
    { client: clientKey('9895022222'), by: 'u1', byName: 'Asha' },
    { client: clientKey('9895022222'), by: 'u2', byName: 'Bina' },
    { client: '', by: 'u2', byName: 'Bina' },
  ]);
  assert.deepEqual(r, { clients: 2, byMember: [{ name: 'Asha', clients: 2 }, { name: 'Bina', clients: 1 }] });
});

test('verification: the works of the range, how many ticked, and which are not', () => {
  const bookings = [bk('a', ['2026-11-16', '2026-11-18']), bk('b', ['2026-11-17']), bk('c', ['2026-11-25'])];
  const r = verificationFigures({ bookings, careOf: care({ a: { verifications: [{ day: '2026-11-16' }] }, b: { verifications: [{ day: '2026-11-17' }] } }), range: next });
  assert.deepEqual([r.works, r.verified, r.pct], [3, 2, 66.7]);
  assert.deepEqual(r.unverified.map((u) => `${u.client} ${u.day}`), ['A 2026-11-18'], 'a verified day does not verify the booking\'s other days');
  assert.deepEqual(verificationFigures({ bookings, careOf: care({}), range: next, tracked: false }).verified, null);
});

test('medical: clients with a condition and their days in the range; emergencies of the week only', () => {
  const bookings = [bk('a', ['2026-11-13', '2026-11-17']), bk('b', ['2026-11-12']), bk('c', ['2026-11-30'])];
  const r = medicalFigures({
    bookings,
    careOf: care({
      a: { medical: { conditions: ['allergy', 'pregnancy'], note: 'latex' }, emergencies: [{ day: '2026-11-13', what: 'Rash', action: 'Stopped, cold pack', byName: 'Asha' }] },
      b: { medical: { conditions: [] } },
      c: { medical: { conditions: ['skin'] } },
    }),
    range: { from: week.from, to: next.to },
    week,
  });
  assert.deepEqual(r.withConditions.map((m) => [m.client, m.days, m.conditions]), [['A', ['2026-11-13', '2026-11-17'], ['Allergy', 'Pregnancy']]]);
  assert.deepEqual(r.emergencies.map((e) => [e.client, e.what]), [['A', 'Rash']]);
  assert.deepEqual(medicalFigures({ bookings, careOf: care({}), range: week, week, tracked: false }), { withConditions: null, emergencies: null });
});

test('workload: day by day against the slots; a blocked day has none; over-capacity days counted', () => {
  const booked = { '2026-11-16': 7, '2026-11-17': 3, '2026-11-20': 1 };
  const r = workloadFigures({ range: next, bookedOn: (d) => booked[d] ?? 0, capacityOn: (d) => (d === '2026-11-17' ? 10 : 6), blockedOn: (d) => d === '2026-11-20' });
  assert.equal(r.days.length, 7);
  assert.deepEqual(r.days.slice(0, 2).map((d) => [d.booked, d.capacity, d.over, d.spare]), [[7, 6, true, 0], [3, 10, false, 7]]);
  assert.deepEqual([r.days[4].capacity, r.days[4].over, r.days[4].blocked], [0, true, true]);
  assert.deepEqual([r.booked, r.capacity, r.overDays, r.busiest.day], [11, 40, 2, '2026-11-16'], 'the blocked 20th adds no slots');
});

test('outsource: one line per work with the bride, the artist, the work, the phone — and a count per artist', () => {
  const r = outsourceFigures([
    { customerName: 'Diya', associateName: 'Rani', phone: '9000', services: ['Bridal'], role: 'Lead artist', firstDay: '2026-11-12', days: 1, bookingNumber: 'B1' },
    { customerName: 'Anu', associateName: 'Rani', phone: '9000', services: [], role: 'Assistant', firstDay: '2026-11-10', days: 2, bookingNumber: 'B2' },
    { customerName: 'Liya', associateName: 'Meena', phone: '9111', services: ['Party'], role: '', firstDay: '2026-11-12', days: 1, bookingNumber: 'B3' },
  ]);
  assert.deepEqual(r.lines.map((l) => [l.bride, l.outsource, l.work]), [['Anu', 'Rani', 'Assistant'], ['Diya', 'Rani', 'Bridal · Lead artist'], ['Liya', 'Meena', 'Party']]);
  assert.deepEqual(r.byPerson, [{ name: 'Rani', phone: '9000', works: 2 }, { name: 'Meena', phone: '9111', works: 1 }]);
  assert.equal(r.total, 3);
});

test('what the Head types: whole counts, yes / no; only what is sent; what is missing to hand it in', () => {
  assert.deepEqual(cleanTyped({ startingMessagesNizan: '12', manpowerPlan: ' two freelancers on 16 Nov ', enoughWork: 'YES' }), {
    set: { startingMessagesNizan: 12, manpowerPlan: 'two freelancers on 16 Nov', enoughWork: 'yes' },
  });
  assert.deepEqual(cleanTyped({ startingMessagesTeamN: '' }).set, { startingMessagesTeamN: null }, 'cleared');
  assert.match(cleanTyped({ startingMessagesNizan: 2.5 }).error, /whole number/);
  assert.match(cleanTyped({ startingMessagesTeamN: -1 }).error, /whole number/);
  assert.match(cleanTyped({ enoughWork: 'maybe' }).error, /yes or no/);
  assert.deepEqual(missingForSubmit({}), ['Nizan starting messages', 'Team N starting messages', 'the plan for extra manpower', 'whether there is enough work']);
  assert.deepEqual(missingForSubmit({ startingMessagesNizan: 0, startingMessagesTeamN: 4, manpowerPlan: 'none needed', enoughWork: 'no' }), [], 'zero is a count');
});

// ── figures typed by hand ───────────────────────────────────────────────────

const figs = () => ({
  trials: { held: 4, completed: 3, cancelled: 1, postponed: 0, converted: 1, maturing: 0, conversionPct: 33.3, prevHeld: 2 },
  photosReviews: { worksDone: 10, photos: null, photosPct: null, clientsDone: 8, reviews: 2, reviewsPct: 25, missingPhotos: [], missingReviews: [] },
  support: { clients: 30, byMember: [], prevClients: 25, monthToDate: 60, monthTarget: 100, monthFrom: '2026-11-01', monthTo: '2026-11-15' },
  verification: {
    thisWeek: { from: '2026-11-09', to: '2026-11-15', works: 10, verified: 9, pct: 90, unverified: [] },
    nextWeek: { from: '2026-11-16', to: '2026-11-22', works: 12, verified: 6, pct: 50, unverified: [] },
  },
  medical: { withConditions: null, emergencies: null },
  workload: {
    thisWeek: { from: '2026-11-09', to: '2026-11-15', days: [], booked: 20, capacity: 42, overDays: 0 },
    nextWeek: { from: '2026-11-16', to: '2026-11-22', days: [], booked: 30, capacity: 42, overDays: 0 },
  },
  outsource: { lines: [{ bride: 'Anu', outsource: 'Rani', work: 'Bridal', phone: '9000', day: '2026-11-10', days: ['2026-11-10'], bookingNumber: 'BN-1' }], total: 1, byPerson: [{ name: 'Rani', phone: '9000', works: 1 }] },
});

test('typed by hand: only known figures, whole counts, null goes back to the records; notes per item; outsource lines need two names', () => {
  assert.deepEqual(cleanTyped({ overrides: { photos: '7', trialsHeld: 0, reviews: '' } }).set, { overrides: { photos: 7, trialsHeld: 0, reviews: null } });
  assert.match(cleanTyped({ overrides: { revenue: 5 } }).error, /not a figure/);
  assert.match(cleanTyped({ overrides: { photos: 1.5 } }).error, /Photos collected must be a whole number/);
  assert.match(cleanTyped({ overrides: [3] }).error, /typed by hand/);
  assert.deepEqual(cleanTyped({ sectionNotes: { photos: '  from the WhatsApp group ' } }).set, { sectionNotes: { photos: 'from the WhatsApp group' } });
  assert.match(cleanTyped({ sectionNotes: { pricing: 'x' } }).error, /not an item/);
  assert.deepEqual(cleanTyped({ outsourceLines: [{ bride: ' Diya ', outsource: 'Meena', work: 'Party', phone: '9111', day: '2026-11-12', extra: 1 }] }).set, {
    outsourceLines: [{ bride: 'Diya', outsource: 'Meena', work: 'Party', phone: '9111', day: '2026-11-12' }],
  });
  assert.match(cleanTyped({ outsourceLines: [{ bride: 'Diya' }] }).error, /line 1: give the bride's name and the outside artist's name/);
  assert.match(cleanTyped({ outsourceLines: [{ bride: 'Diya', outsource: 'Meena', day: '12/11' }] }).error, /YYYY-MM-DD/);
  assert.match(cleanTyped({ outsourceLines: Array.from({ length: 101 }, () => ({ bride: 'a', outsource: 'b' })) }).error, /At most 100/);
  // a figure typed changes on its own; the others typed before stay
  assert.deepEqual(typedSetPaths({ overrides: { photos: 7 }, sectionNotes: { photos: 'x' }, notes: 'n', outsourceLines: [] }), {
    'typed.overrides.photos': 7,
    'typed.sectionNotes.photos': 'x',
    'typed.notes': 'n',
    'typed.outsourceLines': [],
  });
});

test('typed by hand: the report shows the typed figure, keeps the records\' one, and the percentages follow', () => {
  const base = figs();
  const r = effectiveFigures(base, { overrides: { photos: 7, verified: 12, medicalConditions: 2, workloadBooked: null }, outsourceLines: [{ bride: 'Diya', outsource: 'Rani', work: 'Party', phone: '9000', day: '2026-11-12' }] });
  assert.equal(r.figures.photosReviews.photos, 7);
  assert.equal(r.figures.photosReviews.photosPct, 70);
  assert.equal(r.figures.verification.nextWeek.verified, 12);
  assert.equal(r.figures.verification.nextWeek.pct, 100);
  assert.equal(r.figures.medical.conditionsCount, 2, 'typed even where the records kept none');
  assert.equal(r.figures.medical.emergenciesCount, null);
  assert.equal(r.figures.workload.nextWeek.booked, 30, 'null is not typed');
  assert.deepEqual(r.typedKeys.sort(), ['medicalConditions', 'photos', 'verified']);
  assert.equal(r.records.photos, null);
  assert.equal(r.records.verified, 6);
  assert.equal(r.records.workloadCapacity, 42);
  assert.equal(r.figures.outsource.total, 2);
  assert.equal(r.figures.outsource.lines[1].byHand, true);
  assert.deepEqual(r.figures.outsource.byPerson, [{ name: 'Rani', phone: '9000', works: 2 }]);
  assert.equal(base.photosReviews.photos, null, 'the records\' figures are not changed');
  assert.equal(base.outsource.lines.length, 1);
  // nothing typed: the figures as they are
  const same = effectiveFigures(base, {});
  assert.equal(same.figures.trials.conversionPct, 33.3);
  assert.deepEqual(same.typedKeys, []);
  // trials typed → the conversion follows them
  assert.equal(effectiveFigures(base, { overrides: { trialsCompleted: 4, trialsConverted: 2 } }).figures.trials.conversionPct, 50);
});

test('typed by hand: a part bigger than its whole is refused — only where one side was typed', () => {
  const eff = (o) => effectiveFigures(figs(), { overrides: o });
  const problems = (o) => {
    const e = eff(o);
    return overrideProblems(e.figures, e.typedKeys);
  };
  assert.deepEqual(problems({ photos: 10 }), [], 'equal is fine');
  assert.match(problems({ photos: 11 })[0], /Photos collected \(11\) can't be more than makeover works done \(10\)/);
  assert.deepEqual(problems({ photos: 11, worksDone: 11 }), []);
  assert.match(problems({ worksDone: 5 }).join(' '), /Clients done \(8\) can't be more than makeover works done \(5\)/);
  assert.match(problems({ verifyWorks: 5 })[0], /works verified \(6\)/);
  assert.match(problems({ trialsConverted: 5 })[0], /became bookings \(5\)/);
  assert.equal(problems({ trialsCompleted: 5 }).length, 1);
  // the records' own figures are not checked
  const odd = figs();
  odd.photosReviews.reviews = 9; // more than clientsDone in the records — not the Head's doing
  const e = effectiveFigures(odd, { overrides: { supportClients: 40 } });
  assert.deepEqual(overrideProblems(e.figures, e.typedKeys), []);
});

test('the PDF/Excel summary marks a typed figure with the records\' one and adds the item\'s note', () => {
  const typed = { startingMessagesNizan: 5, startingMessagesTeamN: 6, overrides: { photos: 7, workloadBooked: 33 }, sectionNotes: { photos: 'counted from WhatsApp' }, outsourceLines: [{ bride: 'Diya', outsource: 'Rani', work: '', phone: '', day: '' }] };
  const e = effectiveFigures(figs(), typed);
  const rows = weeklySummaryRows({ figures: e.figures, records: e.records, typed });
  const row = (what) => rows.find((r) => r[1] === what)?.[2];
  assert.equal(row('Photos collected'), '7 of 10 (70%) · typed by hand (records: —)');
  assert.equal(row('Makeover works done'), '10', 'not typed: no mark');
  assert.match(row('Coming week: bookings against slots'), /^33 of 42 · typed by hand \(records: 30 \/ 42\)$/);
  assert.equal(row('Works by outside artists'), '2 (1 typed by hand)');
  const noteAt = rows.findIndex((r) => r[1] === 'Note');
  assert.equal(rows[noteAt][2], 'counted from WhatsApp');
  assert.equal(rows[noteAt - 1][1], 'Reviews collected (clients)', 'under its own item');
  assert.equal(row('Clients with a medical condition (this + coming week)'), '—');
});
