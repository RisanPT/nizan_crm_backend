// Pure unit tests: node --test tests/artistAllocation.test.js
// Smart Booking Allocation — the deck's rule (time + 30-minute location, else the next in rotation), slots, extras, leave, preferences.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  autoPick, buildState, driveBetween, fourthWorkWindows, fmtDuration, fmtTime, halfOf, normalizeSettings, planUnits, rankCandidates, rotationFrom, withAllocation, workUnits,
} from '../utils/artistAllocation.js';

// places (pincode centres as the cache would hold them)
const PINS = {
  673001: { lat: 11.2588, lng: 75.7804 }, // Calicut
  673631: { lat: 11.1786, lng: 75.8418 }, // Feroke — ~11 km from Calicut
  676505: { lat: 11.051, lng: 76.0711 }, // Malappuram — ~40 km
  691001: { lat: 8.8932, lng: 76.6141 }, // Kollam — ~270 km
};
const DISTRICTS = { 673001: 'kkd', 673631: 'kkd', 676505: 'mlp', 691001: 'klm' };
const NAMES = { kkd: 'Calicut', mlp: 'Malappuram', klm: 'Kollam' };
const ctx = { coordsOfPin: (p) => PINS[p] ?? null, districtOfPin: (p) => DISTRICTS[p] ?? '', districtName: (id) => NAMES[id] ?? '' };

const DAY = '2026-12-12';
const at = (day, hhmm) => new Date(`${day}T${hhmm}:00+05:30`);
let seq = 0;
const booking = ({ pin, start, end, day = DAY, staff = [], items, number, eventSlot = '', status = 'confirmed', mapUrl = '' }) => {
  seq += 1;
  return {
    _id: `b${seq}`,
    bookingNumber: number ?? String(2600 + seq),
    customerName: `Client ${seq}`,
    status,
    pincode: pin ?? '',
    districtId: pin ? DISTRICTS[pin] : '',
    selectedDates: [day],
    serviceStart: at(day, start ?? '09:00'),
    serviceEnd: at(day, end ?? '10:00'),
    eventSlot,
    mapUrl,
    assignedStaff: staff,
    bookingItems: items,
  };
};
const unitOf = (b) => workUnits(b, ctx)[0];

const person = (id, name, extra = {}) => ({ _id: id, id, name, status: 'active', ...extra });
const NAMES6 = ['Nihala', 'Irfana', 'Sandra', 'Fidha', 'Anagha', 'Nedha'];
const teams = (over = {}) =>
  NAMES6.map((n, i) => ({
    id: `t${i + 1}`,
    name: `Team ${n}`,
    rotationOrder: i + 1,
    active: true,
    lead: person(`L${i + 1}`, n),
    assistants: [person(`A${i + 1}`, `${n}'s assistant`)],
    slots: { morning: 2, evening: 1 },
    extraAllowed: true,
    preferredDistrictIds: [],
    preferredPincodes: [],
    ...(over[n] ?? {}),
  }));
const lead = (i) => ({ employeeId: `L${i}`, artistName: NAMES6[i - 1], roleType: 'lead' });
const asst = (i) => ({ employeeId: `A${i}`, artistName: 'asst', roleType: 'assistant' });
const stateWith = (others, extra = {}) => buildState({ teams: extra.teams ?? teams(), otherUnits: others.flatMap((b) => workUnits(b, ctx)), leaves: extra.leaves, extrasUsed: extra.extrasUsed, lastStartedTeamId: extra.lastStartedTeamId });

test('the formats the reasons are written in', () => {
  assert.deepEqual([fmtTime('09:00'), fmtTime('14:30'), fmtTime('00:05'), fmtTime('12:00')], ['9:00 AM', '2:30 PM', '12:05 AM', '12:00 PM']);
  assert.deepEqual([fmtDuration(12), fmtDuration(65), fmtDuration(60), fmtDuration(200)], ['12 min', '1 h 5 min', '1 h', 'over 3 h']);
});

test('morning or evening by the start time (cut-off 14:00); with no time set, by the event\'s words', () => {
  assert.equal(halfOf({ start: '13:59' }), 'morning');
  assert.equal(halfOf({ start: '14:00' }), 'evening');
  assert.equal(halfOf({ start: '13:30' }, '13:00'), 'evening');
  assert.equal(halfOf({ start: '09:00', timeSet: false, eventSlot: 'Reception | Morning' }), 'evening');
  // a booking saved without times (09:00–10:00 placeholder) whose event is a reception: an evening job, "time not set"
  const u = unitOf(booking({ pin: '673001', eventSlot: 'Evening reception' }));
  assert.deepEqual([u.days[0].start, u.days[0].end, u.days[0].timeSet, u.days[0].half], ['16:00', '19:00', false, 'evening']);
  // a late start keeps its own IST day
  const late = unitOf(booking({ pin: '673001', start: '23:30', end: '23:50' }));
  assert.deepEqual([late.days[0].day, late.days[0].start], [DAY, '23:30']);
});

test('a booking as units: each package with its own days, times and place; one without packages is one unit', () => {
  const b = booking({
    pin: '673001',
    start: '08:00',
    end: '11:00',
    items: [
      { service: 'Bridal', assignedStaff: [lead(1)] },
      { service: 'Reception', selectedDates: ['2026-12-13'], startTime: '17:00', endTime: '20:00', mapUrl: 'https://www.google.com/maps/@8.8932,76.6141,17z', districtId: 'klm' },
    ],
  });
  b.selectedDates = [DAY, '2026-12-13'];
  const units = workUnits(b, ctx);
  assert.deepEqual(units.map((u) => [u.unitKey, u.label, u.days.map((d) => d.day).join(',')]), [['i:0', 'Bridal', `${DAY},2026-12-13`], ['i:1', 'Reception', '2026-12-13']]);
  assert.deepEqual([units[1].days[0].start, units[1].days[0].half, units[1].days[0].place.precision, units[1].days[0].place.label], ['17:00', 'evening', 'pin', 'Kollam']);
  assert.equal(units[0].days[0].place.precision, 'pincode');
  // the package in another district does not borrow the booking's pincode
  const other = workUnits(booking({ pin: '673001', items: [{ service: 'x', districtId: 'klm' }] }), ctx)[0];
  assert.deepEqual([other.days[0].place.precision, other.days[0].place.pincode], ['unknown', '']);
});

test('the drive: estimated minutes (no handling time); the same pincode is a short hop; an unplaced venue is unknown', () => {
  const kkd = { ...PINS[673001], precision: 'pincode', pincode: '673001' };
  const fer = { ...PINS[673631], precision: 'pincode', pincode: '673631' };
  const d = driveBetween(kkd, fer);
  assert.ok(d.known && d.minutes >= 15 && d.minutes <= 30, `Calicut → Feroke ${d.minutes} min`);
  assert.deepEqual(driveBetween(kkd, { ...kkd }), { minutes: 5, km: 2, known: true, approx: true });
  assert.equal(driveBetween(kkd, { precision: 'unknown' }).known, false);
});

test('THE DECK\'S EXAMPLE: Calicut 9:00 → Nihala; nearby → Nihala again; Kollam → Irfana (the next in rotation)', () => {
  const b1 = booking({ pin: '673001', start: '09:00', end: '11:00', number: 'B1' });
  const b2 = booking({ pin: '673631', start: '12:00', end: '14:00', number: 'B2' });
  const b3 = booking({ pin: '691001', start: '16:00', end: '19:00', number: 'B3' });
  const { plan, state } = planUnits({ units: [b3, b1, b2].map(unitOf), state: stateWith([]), settings: {} });
  const by = new Map(plan.map((p) => [p.unit.bookingNumber, p]));
  assert.deepEqual([by.get('B1').pick.teamName, by.get('B1').pick.tier], ['Team Nihala', 'new_route']);
  assert.equal(by.get('B1').pick.reason, 'Starts a new route — next in rotation');
  assert.deepEqual([by.get('B2').pick.teamName, by.get('B2').pick.tier], ['Team Nihala', 'continue']);
  assert.match(by.get('B2').pick.reason, /^Same area as her 9:00 AM Calicut job — \d+ min \(\d+ km\) away by pincode$/);
  assert.deepEqual([by.get('B3').pick.teamName, by.get('B3').pick.tier], ['Team Irfana', 'new_route']);
  const nihalaOnB3 = by.get('B3').candidates.find((c) => c.teamName === 'Team Nihala');
  assert.equal(nihalaOnB3.tier, 'blocked');
  assert.match(nihalaOnB3.reason, /^Can't be ready: her 12:00 PM job ends 2:00 PM, over \d h drive \+ 30 min ready → .*; this starts 4:00 PM$/);
  assert.equal(state.lastStartedTeamId, 't2', 'the rotation moved to Irfana');
});

test('a far venue: the artist with time but far away comes after a new route (the next free artist starts one)', () => {
  const b1 = booking({ pin: '673001', start: '09:00', end: '11:00', staff: [lead(1), asst(1)] });
  const far = unitOf(booking({ pin: '676505', start: '15:00', end: '17:00' }));
  const c = rankCandidates({ unit: far, state: stateWith([b1], { lastStartedTeamId: 't1' }), settings: {} });
  assert.deepEqual([c[0].teamName, c[0].tier], ['Team Irfana', 'new_route']);
  const nihala = c.find((x) => x.teamName === 'Team Nihala');
  assert.equal(nihala.tier, 'far');
  assert.match(nihala.reason, /^Malappuram is (1 h \d+ min|\d+ min) from her 9:00 AM Calicut job \(she has time\)$/);
});

test('between two jobs: a 12:00 job nearby fits both ways; a 14:30 job can\'t make her next one — said exactly', () => {
  const morning = booking({ pin: '673001', start: '09:00', end: '11:00', staff: [lead(1)] });
  const afternoon = booking({ pin: '673631', start: '15:30', end: '18:00', staff: [lead(1)] });
  const s = stateWith([morning, afternoon]);
  const fits = rankCandidates({ unit: unitOf(booking({ pin: '673001', start: '12:00', end: '13:30' })), state: s, settings: {} });
  assert.equal(fits.find((c) => c.teamName === 'Team Nihala').tier, 'continue');
  const tight = rankCandidates({ unit: unitOf(booking({ pin: '673001', start: '14:30', end: '15:00' })), state: s, settings: {} });
  const n = tight.find((c) => c.teamName === 'Team Nihala');
  assert.equal(n.tier, 'blocked');
  assert.match(n.reason, /^Can't make her 3:30 PM Calicut job: this ends 3:00 PM, \d+ min drive \+ 30 min → 3:\d\d PM$/);
});

test('slots: two morning jobs fill her morning; the evening is her own; a team with 1 morning slot', () => {
  const m1 = booking({ pin: '673001', start: '07:00', end: '09:00', staff: [lead(1)] });
  const m2 = booking({ pin: '673001', start: '10:00', end: '12:00', staff: [lead(1)] });
  const s = stateWith([m1, m2]);
  const morning = rankCandidates({ unit: unitOf(booking({ pin: '673001', start: '13:00', end: '13:45' })), state: s, settings: {} });
  const n = morning.find((c) => c.teamName === 'Team Nihala');
  assert.match(n.reason, /^Both morning slots taken/);
  assert.equal(morning[0].teamName, 'Team Irfana');
  const evening = rankCandidates({ unit: unitOf(booking({ pin: '673001', start: '15:00', end: '17:00' })), state: s, settings: {} });
  assert.deepEqual([evening[0].teamName, evening[0].tier, evening[0].slots[0].half, evening[0].slots[0].used], ['Team Nihala', 'continue', 'evening', 0]);
  const one = rankCandidates({ unit: unitOf(booking({ pin: '673001', start: '13:00', end: '13:45' })), state: stateWith([m1], { teams: teams({ Nihala: { slots: { morning: 1, evening: 1 } } }) }), settings: {} });
  assert.match(one.find((c) => c.teamName === 'Team Nihala').reason, /^Her morning slot taken/);
});

test('EXTRA: once every morning slot is full, the best-fit route gets a 4th slot needing the Artist Head; 2 a day at most', () => {
  const full = [];
  for (let i = 1; i <= 6; i += 1) {
    full.push(booking({ pin: '673001', start: '07:00', end: '08:30', staff: [lead(i)] }));
    full.push(booking({ pin: i === 3 ? '673631' : '676505', start: '10:00', end: '11:30', staff: [lead(i)] }));
  }
  const u = unitOf(booking({ pin: '673631', start: '12:30', end: '13:30' }));
  const c = rankCandidates({ unit: u, state: stateWith(full), settings: {} });
  assert.deepEqual([c[0].teamName, c[0].tier, c[0].needsApproval, c[0].extra.extraNo], ['Team Sandra', 'extra', true, 1]);
  assert.match(c[0].reason, /^EXTRA 3rd slot — every morning slot is full; her 10:00 AM Calicut job — \d+ min .*Needs the Artist Head's OK$/);
  assert.ok(c.slice(1).every((x) => x.tier === 'blocked'), 'the far ones do not get an extra');
  // both extras of the day used → none offered
  const none = rankCandidates({ unit: u, state: stateWith(full, { extrasUsed: new Map([[DAY, 2]]) }), settings: {} });
  assert.equal(none[0].tier, 'blocked');
  assert.match(none.find((x) => x.teamName === 'Team Sandra').reason, /both extra slots for 12 Dec are used/);
  // a team that opted out of extras
  const optedOut = rankCandidates({ unit: u, state: stateWith(full, { teams: teams({ Sandra: { extraAllowed: false } }) }), settings: {} });
  assert.equal(optedOut.find((x) => x.teamName === 'Team Sandra').tier, 'blocked');
  // while another team still has a normal slot, no extra
  const roomLeft = rankCandidates({ unit: u, state: stateWith(full.slice(0, 11)), settings: {} });
  assert.notEqual(roomLeft[0].tier, 'extra');
  assert.match(roomLeft.find((x) => x.teamName === 'Team Sandra').reason, /other artists are free/);
  // 'day_full': evening slots still free → no morning extra
  const dayFull = rankCandidates({ unit: u, state: stateWith(full), settings: { extraWhen: 'day_full' } });
  assert.equal(dayFull[0].tier, 'blocked');
});

test('leave: a full day blocks; a half-day blocks only that half; an inactive lead is blocked; a busy assistant is only a warning', () => {
  const u = unitOf(booking({ pin: '673001', start: '09:00', end: '11:00' }));
  const leaves = new Map([['L1', [{ fromDay: DAY, toDay: DAY, halfDay: 'none' }]], ['L2', [{ fromDay: DAY, toDay: DAY, halfDay: 'second' }]], ['L3', [{ fromDay: DAY, toDay: DAY, halfDay: 'first' }]]]);
  const c = rankCandidates({ unit: u, state: stateWith([], { leaves }), settings: {} });
  const of = (n) => c.find((x) => x.teamName === `Team ${n}`);
  assert.match(of('Nihala').reason, /^Nihala is on leave on 12 Dec$/);
  assert.equal(of('Irfana').tier, 'new_route', 'an evening half-day leave leaves her morning free');
  assert.ok(of('Irfana').warnings.some((w) => /half-day leave \(evening\)/.test(w)));
  assert.match(of('Sandra').reason, /half-day leave \(morning\)/);
  assert.equal(c[0].teamName, 'Team Irfana');
  const inactive = rankCandidates({ unit: u, state: stateWith([], { teams: teams({ Nihala: { lead: person('L1', 'Nihala', { status: 'inactive' }) } }) }), settings: {} });
  assert.match(inactive.find((x) => x.teamName === 'Team Nihala').reason, /no longer active/);
  // her assistant is on another job at that time: a warning, the team still fits
  const other = booking({ pin: '673001', start: '09:00', end: '10:00', staff: [{ employeeId: 'A1', artistName: 'x', roleType: 'assistant' }] });
  const warn = rankCandidates({ unit: u, state: stateWith([other]), settings: {} });
  const n = warn.find((x) => x.teamName === 'Team Nihala');
  assert.equal(n.tier, 'new_route');
  assert.ok(n.warnings.some((w) => /Nihala's assistant is on #\d+ at 9:00 AM — change assistant/.test(w)));
});

test('preferred places: a new route in Kollam goes first to the team that prefers Kollam; else rotation from the pointer', () => {
  const u = unitOf(booking({ pin: '691001', start: '09:00', end: '11:00' }));
  const pref = rankCandidates({ unit: u, state: stateWith([], { teams: teams({ Fidha: { preferredDistrictIds: ['klm'] } }) }), settings: {} });
  assert.deepEqual([pref[0].teamName, pref[0].reason], ['Team Fidha', 'Starts a new route — prefers Kollam']);
  const area = rankCandidates({ unit: u, state: stateWith([], { teams: teams({ Fidha: { preferredDistrictIds: ['klm'] }, Anagha: { preferredPincodes: ['691001'] } }) }), settings: {} });
  assert.equal(area[0].teamName, 'Team Anagha', 'her pincode area beats a district');
  const rot = rankCandidates({ unit: u, state: stateWith([], { lastStartedTeamId: 't2' }), settings: {} });
  assert.equal(rot[0].teamName, 'Team Sandra', 'the one after the team that last started a route');
  assert.deepEqual(rotationFrom(teams(), 't6').map((t) => t.id), ['t1', 't2', 't3', 't4', 't5', 't6']);
});

test('an unplaced venue never counts as "the same area"; the screen asks for a map pin', () => {
  // (9:00–10:30: a 9:00–10:00 booking is the "no time set" placeholder, read as a 3-hour job)
  const b1 = booking({ pin: '673001', start: '09:00', end: '10:30', staff: [lead(1)] });
  // an unknown drive counts 90 min for the clock: 10:30 + 1 h 30 + 30 min ready = 12:30
  const u = unitOf(booking({ pin: '', start: '13:00', end: '14:00' }));
  const c = rankCandidates({ unit: u, state: stateWith([b1], { lastStartedTeamId: 't1' }), settings: {} });
  const n = c.find((x) => x.teamName === 'Team Nihala');
  assert.equal(n.tier, 'far');
  assert.match(n.reason, /no map pin or pincode/);
  assert.equal(c[0].tier, 'new_route');
});

test('a booking over two days: leave on the second day blocks the team, the day named', () => {
  const b = booking({ pin: '673001', start: '09:00', end: '11:00' });
  b.selectedDates = [DAY, '2026-12-13'];
  const c = rankCandidates({ unit: workUnits(b, ctx)[0], state: stateWith([], { leaves: new Map([['L1', [{ fromDay: '2026-12-13', toDay: '2026-12-13', halfDay: 'none' }]]]) }), settings: {} });
  const n = c.find((x) => x.teamName === 'Team Nihala');
  assert.equal(n.tier, 'blocked');
  assert.equal(n.reason, '13 Dec: Nihala is on leave on 13 Dec');
  assert.equal(n.details.length, 2);
  assert.equal(c[0].teamName, 'Team Irfana');
});

test('the same booking\'s packages at the same time (bride + family) take one slot, not two; no clash with itself', () => {
  const b = booking({ pin: '673001', start: '09:00', end: '11:00', items: [{ service: 'Bride', assignedStaff: [lead(1)] }, { service: 'Family', startTime: '09:30', endTime: '11:00' }] });
  const [bride, family] = workUnits(b, ctx);
  const s = buildState({ teams: teams(), otherUnits: [bride] });
  const c = rankCandidates({ unit: family, state: s, settings: {} });
  const n = c.find((x) => x.teamName === 'Team Nihala');
  assert.notEqual(n.tier, 'blocked');
  assert.equal(n.slots[0].needsSlot, false);
});

test('ranking is the same every time (ties broken by rotation order)', () => {
  const u = unitOf(booking({ pin: '673001', start: '09:00', end: '11:00' }));
  const a = rankCandidates({ unit: u, state: stateWith([]), settings: {} }).map((c) => c.teamName);
  const b = rankCandidates({ unit: u, state: stateWith([]), settings: {} }).map((c) => c.teamName);
  assert.deepEqual(a, b);
  assert.deepEqual(a, NAMES6.map((n) => `Team ${n}`));
});

test('a cancelled booking holds nobody (state built only from what is happening is the caller\'s job); settings are clamped', () => {
  const s = normalizeSettings({ travelLimitMin: 'x', extrasPerDay: 99, eveningCutoff: '25:00', extraWhen: 'nope' });
  assert.deepEqual([s.travelLimitMin, s.extrasPerDay, s.eveningCutoff, s.extraWhen], [30, 10, '14:00', 'half_full']);
  // allocating moves the state on: her job appears, the pointer moves only for a new route
  const u = unitOf(booking({ pin: '673001', start: '09:00', end: '11:00' }));
  const st = stateWith([]);
  const next = withAllocation(st, u, st.teams[0], { tier: 'new_route' });
  assert.equal(next.jobs.get('L1').get(DAY).length, 1);
  assert.equal(next.lastStartedTeamId, 't1');
  assert.equal(st.jobs.size, 0, 'the old state is untouched');
});

// ── automatic allocation: only clean matches are given without a person ──────

const auto = (unit, state) => autoPick({ unit, candidates: rankCandidates({ unit, state, settings: {} }) });

test('AUTO: Nihala prefers Kozhikode (Calicut) → a new Kozhikode booking is hers on its own; the same area as her job is hers too', () => {
  const kkdTeams = teams({ Nihala: { preferredDistrictIds: ['kkd'] } });
  const u = unitOf(booking({ pin: '673001', start: '10:30', end: '12:30' }));
  const a = auto(u, stateWith([], { teams: kkdTeams, lastStartedTeamId: 't1' }));
  assert.equal(a.ok, true);
  assert.deepEqual([a.cand.teamName, a.cand.tier, a.cand.reason], ['Team Nihala', 'new_route', 'Starts a new route — prefers Calicut']);
  // her 9:00 Calicut job, then a Feroke job at 12:00 — the same area, both ways on time
  const b1 = booking({ pin: '673001', start: '09:00', end: '11:00', staff: [lead(1), asst(1)] });
  const near = auto(unitOf(booking({ pin: '673631', start: '12:00', end: '14:00' })), stateWith([b1], { lastStartedTeamId: 't1' }));
  assert.deepEqual([near.ok, near.cand.teamName, near.cand.tier], [true, 'Team Nihala', 'continue']);
});

test('AUTO: anything doubtful waits for CRM — said why', () => {
  // a new route nobody prefers: CRM picks
  const kollam = auto(unitOf(booking({ pin: '691001', start: '10:30', end: '12:30' })), stateWith([]));
  assert.equal(kollam.ok, false);
  assert.match(kollam.reason, /^No free artist has Kollam as a preferred location/);
  // no start time (the 09:00–10:00 placeholder)
  const noTime = auto(unitOf(booking({ pin: '673001' })), stateWith([], { teams: teams({ Nihala: { preferredDistrictIds: ['kkd'] } }) }));
  assert.deepEqual([noTime.ok, noTime.reason], [false, 'The booking has no start time — add it so the route can be checked']);
  // no pincode, no map pin
  const unplaced = auto(unitOf(booking({ pin: '', start: '10:30', end: '12:30' })), stateWith([]));
  assert.deepEqual([unplaced.ok, unplaced.reason], [false, 'The venue has no pincode or map pin — add one so the route can be checked']);
  // the only team is on a far job that day: a "far" match is not given
  const one = teams().slice(0, 1);
  const b1 = booking({ pin: '673001', start: '09:00', end: '11:00', staff: [lead(1)] });
  const far = auto(unitOf(booking({ pin: '676505', start: '15:00', end: '17:00' })), stateWith([b1], { teams: one }));
  assert.equal(far.ok, false);
  assert.match(far.reason, /^Not a close match — Malappuram is .* from her 9:00 AM Calicut job \(she has time\)$/);
  // every morning slot full: an EXTRA is the Artist Head's call — CRM decides, nothing is asked automatically
  const m1 = booking({ pin: '673001', start: '07:00', end: '08:30', staff: [lead(1)] });
  const m2 = booking({ pin: '673631', start: '09:30', end: '11:00', staff: [lead(1)] });
  const full = auto(unitOf(booking({ pin: '673001', start: '12:00', end: '13:00' })), stateWith([m1, m2], { teams: one }));
  assert.deepEqual([full.ok, full.reason], [false, "Every morning slot that day is full — CRM decides (an extra slot needs the Artist Head's OK)"]);
  // the best team's assistant is busy then: CRM checks
  const busy = booking({ pin: '673001', start: '10:30', end: '11:30', staff: [{ employeeId: 'A1', artistName: 'x', roleType: 'assistant' }] });
  const asstBusy = auto(unitOf(booking({ pin: '673001', start: '10:30', end: '12:30' })), stateWith([busy], { teams: teams({ Nihala: { preferredDistrictIds: ['kkd'] } }) }));
  assert.equal(asstBusy.ok, false);
  assert.match(asstBusy.reason, /^Team Nihala fits, but Nihala's assistant is on #\d+ at 10:30 AM — CRM checks the assistants$/);
  // nobody free / no teams at all
  const leaves = new Map([['L1', [{ fromDay: DAY, toDay: DAY, halfDay: 'none' }]]]);
  const blocked = auto(unitOf(booking({ pin: '673001', start: '10:30', end: '12:30' })), stateWith([], { teams: one, leaves }));
  assert.deepEqual([blocked.ok, blocked.reason], [false, 'No team is free for it — Nihala is on leave on 12 Dec']);
  assert.deepEqual(autoPick({ unit: unitOf(booking({ pin: '673001', start: '10:30', end: '12:30' })), candidates: [] }), { ok: false, reason: 'No artist team is set up yet' });
});

// ── a full day: where a 4th work could still go ──────────────────────────────

test('4TH WORK: her gaps near her works — both drives + ready time left; a far venue or a tiny gap gives none; a free team is a new route, not a 4th work', () => {
  // Nihala's close route: 9:00 Calicut, 12:00 Feroke, 5:00 PM Calicut
  const day = [booking({ pin: '673001', start: '09:00', end: '11:00', staff: [lead(1)] }), booking({ pin: '673631', start: '12:00', end: '13:30', staff: [lead(1)] }), booking({ pin: '673001', start: '17:00', end: '19:00', staff: [lead(1)] })];
  const st = stateWith(day, { teams: teams().slice(0, 2) });
  const nj = unitOf(booking({ pin: '673001', start: '14:30', end: '16:00' })).days[0];
  const w = fourthWorkWindows({ nj, state: st, settings: {} });
  assert.deepEqual(w.map((x) => x.teamName), ['Team Nihala'], 'Irfana has no work that day — a new route, not a 4th work');
  const gaps = w[0].windows.map((x) => [x.from, x.to]);
  // before 9:00 (from 5:00), between Feroke and the 5:00 PM job, and after 7:00 PM (to 10:00 PM); not between 11:00 and 12:00 (too short)
  assert.equal(gaps.length, 3);
  assert.deepEqual(gaps[0], ['05:00', '08:25']);
  assert.match(gaps[1].join('–'), /^14:2\d–16:25$/);
  assert.deepEqual(gaps[2], ['19:35', '22:00']);
  assert.match(w[0].windows[1].reason, /^\d+ min from her 12:00 PM Calicut job$/);
  // Kollam is hours away from her day: no gap counts
  const far = unitOf(booking({ pin: '691001', start: '14:30', end: '16:00' })).days[0];
  assert.deepEqual(fourthWorkWindows({ nj: far, state: st, settings: {} }), []);
  // a 4-hour work fits only the early-morning and late gaps' lengths? none is 4 h long except 5:00–8:25 (3 h 25) — so none
  const long = unitOf(booking({ pin: '673001', start: '14:00', end: '18:00' })).days[0];
  assert.deepEqual(fourthWorkWindows({ nj: long, state: st, settings: {} }), []);
});

test('4TH WORK: one work past her slots a day — once she has it, no more extra for her (nor gaps)', () => {
  // her evening (1 slot) already holds two works: one past her plan
  const day = [booking({ pin: '673001', start: '09:00', end: '11:00', staff: [lead(1)] }), booking({ pin: '673001', start: '14:30', end: '16:00', staff: [lead(1)] }), booking({ pin: '673001', start: '17:00', end: '19:00', staff: [lead(1)] })];
  const st = stateWith(day, { teams: teams().slice(0, 1) });
  const u = unitOf(booking({ pin: '673001', start: '19:45', end: '21:00' }));
  const c = rankCandidates({ unit: u, state: st, settings: {} });
  assert.equal(c[0].tier, 'blocked');
  assert.match(c[0].reason, /already has a work past her slots that day/);
  assert.deepEqual(fourthWorkWindows({ nj: u.days[0], state: st, settings: {} }), []);
});
