// Pure unit tests: node --test tests/workReview.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {
  workScore, bandOf, needsAttention, reviewFiltersOf, teamOfBooking, teamOfReview, workTeam, reviewView, eventDayOf, workView,
  qualityByArtist, qualityTotals, worstFirst, artistKey,
} from '../utils/workReview.js';

const id = () => new mongoose.Types.ObjectId();
const NIHALA = id();
const SANA = id();
const RIYA = id();

const booking = (over = {}) => ({
  _id: id(),
  bookingNumber: 'BK-1001',
  customerName: 'Amina K',
  selectedDates: ['2026-12-12'],
  bookingDate: new Date('2026-12-11T18:30:00Z'),
  service: 'Bridal Makeup',
  district: 'Kozhikode',
  status: 'completed',
  assignedStaff: [
    { employeeId: NIHALA, artistName: 'Nihala', roleType: 'lead' },
    { employeeId: id(), artistName: 'Driver Dev', roleType: 'driver' },
  ],
  bookingItems: [{ service: 'Bridal Makeup', selectedDates: ['2026-12-12'], assignedStaff: [{ employeeId: SANA, artistName: 'Sana', roleType: 'assistant' }, { employeeId: NIHALA, artistName: 'Nihala', roleType: 'lead' }] }],
  ...over,
});

const submitted = (over = {}) => ({ _id: id(), status: 'submitted', overall: 5, makeup: 5, hair: 4, saree: 5, nps: 10, brideScore: 4.8, teamMemberScore: 4.7, teamBehaviour: { punctuality: 5, professionalism: 5, communication: 4, politeness: 5, handlingRequests: 5 }, teamMember: { skill: 5, attention: 5, timeManagement: 4 }, likedMost: 'The base', couldBeBetter: '', complaint: false, submittedAt: new Date('2026-12-13'), ...over });

test('the work\'s rating: the overall stars, else the average of her answers; bands at 4.5 and 3.5', () => {
  assert.equal(workScore({ overall: 4, brideScore: 2 }), 4);
  assert.equal(workScore({ overall: 0, brideScore: 3.2 }), 3.2);
  assert.equal(workScore({}), 0);
  assert.deepEqual([5, 4.5, 4.4, 3.5, 3.4, 1, 0].map(bandOf), ['great', 'great', 'good', 'good', 'low', 'low', 'none']);
});

test('a review needs a look when it is a complaint or a low rating; the filters it falls under', () => {
  assert.equal(needsAttention(submitted()), false);
  assert.equal(needsAttention(submitted({ overall: 3 })), true);
  assert.equal(needsAttention(submitted({ complaint: true })), true);
  assert.equal(needsAttention({ status: 'pending', overall: 1 }), false, 'not answered yet');
  assert.deepEqual(reviewFiltersOf(submitted()), ['great']);
  assert.deepEqual(reviewFiltersOf(submitted({ overall: 2, complaint: true })), ['low', 'complaint']);
  assert.deepEqual(reviewFiltersOf({ status: 'pending' }), ['waiting']);
  assert.deepEqual(reviewFiltersOf({ status: 'expired' }), []);
  assert.deepEqual(reviewFiltersOf(null), []);
});

test('the team on a booking: every artist once (whole booking and packages), drivers out, the lead first', () => {
  const t = teamOfBooking(booking());
  assert.deepEqual(t.map((m) => [m.name, m.role, m.key]), [['Nihala', 'Lead Artist', String(NIHALA)], ['Sana', 'Assistant', String(SANA)]]);
  // a name kept without an id is keyed by the name
  const legacy = teamOfBooking({ assignedStaff: [{ artistName: 'Old Artist', roleType: 'lead' }] });
  assert.equal(legacy[0].key, 'n:old artist');
});

test('the team the client rated is the review\'s own record (submitted); otherwise who is on the booking now', () => {
  const r = submitted({ teamMembers: [{ name: 'Riya', role: 'Lead Artist', employeeId: RIYA }] });
  assert.deepEqual(workTeam(booking(), r).map((m) => m.name), ['Riya'], 'the booking changed after the work — the rating is Riya\'s');
  assert.deepEqual(workTeam(booking(), { status: 'pending', teamMembers: [{ name: 'Riya', employeeId: RIYA }] }).map((m) => m.name), ['Nihala', 'Sana']);
  assert.deepEqual(teamOfReview({ artistNames: ['Ann', 'Bea'], artistName: 'Bea' }).map((m) => [m.name, m.role]), [['Bea', 'Lead Artist'], ['Ann', 'Team member']]);
});

test('the review as the gallery shows it: ratings by area, answers in words, comments, flags', () => {
  const v = reviewView(submitted({ lookMatch: 'exactly', bookAgain: 'maybe', couldBeBetter: 'Hair came loose', complaint: true }));
  assert.equal(v.score, 5);
  assert.equal(v.band, 'great');
  assert.deepEqual(v.areas.find((a) => a.key === 'hair'), { key: 'hair', label: 'Hair', value: 4 });
  assert.deepEqual(v.answers, [{ label: 'The look matched what she wanted', value: 'Exactly as expected' }, { label: 'Would book us again', value: 'Maybe' }]);
  assert.equal(v.couldBeBetter, 'Hair came loose');
  assert.equal(v.needsAttention, true);
  assert.equal(v.token, undefined, 'the form\'s private link is never sent');
  const p = reviewView({ _id: id(), status: 'pending', sentAt: new Date('2026-12-13T03:30:00Z'), overall: 0 });
  assert.deepEqual(Object.keys(p).sort(), ['id', 'sentAt', 'status', 'submittedAt']);
  assert.equal(reviewView(null), null);
});

test('the event day: the first chosen date, else the booking date in India', () => {
  assert.equal(eventDayOf(booking({ selectedDates: ['2026-12-14', '2026-12-12'] })), '2026-12-12');
  assert.equal(eventDayOf({ bookingDate: new Date('2026-12-11T19:00:00Z') }), '2026-12-12');
  assert.equal(eventDayOf({}), '');
});

test('the work behind a gallery item: booking, client, day, services, place, artists and the review', () => {
  const b = booking();
  const w = workView(b, submitted(), { workDay: '2026-12-12' });
  assert.equal(w.bookingNumber, 'BK-1001');
  assert.equal(w.client, 'Amina K');
  assert.equal(w.eventDay, '2026-12-12');
  assert.deepEqual(w.services, ['Bridal Makeup']);
  assert.equal(w.place, 'Kozhikode');
  assert.deepEqual(w.artists.map((a) => a.name), ['Nihala', 'Sana']);
  assert.equal(w.review.band, 'great');
  assert.equal(workView(b, null).review, null, 'no review sent yet');
});

const work = (artists, review, over = {}) => ({ bookingId: String(id()), eventDay: '2026-12-12', artists, review: review ? reviewView(review) : null, assets: 2, ...over });
const N = { key: String(NIHALA), id: String(NIHALA), name: 'Nihala' };
const S = { key: String(SANA), id: String(SANA), name: 'Sana' };

test('every artist on a work gets its rating — the low one and the complaint count for both', () => {
  const rows = qualityByArtist([
    work([N, S], submitted({ overall: 2, complaint: true, hair: 2, couldBeBetter: 'Hair fell' }), { eventDay: '2026-12-01' }),
    work([N], submitted({ overall: 5 })),
    work([S], { status: 'pending' }),
  ]);
  const n = rows.find((r) => r.name === 'Nihala');
  const s = rows.find((r) => r.name === 'Sana');
  assert.deepEqual([n.works, n.reviewed, n.avgScore, n.complaints, n.low, n.great, n.assets], [2, 2, 3.5, 1, 1, 1, 4]);
  assert.deepEqual([s.works, s.reviewed, s.waiting, s.avgScore, s.complaints, s.low], [2, 1, 1, 2, 1, 1]);
  assert.equal(s.weakest.key, 'hair', 'her weakest area');
  assert.equal(s.weakest.avg, 2);
  assert.equal(n.lastIssueDay, '2026-12-01');
  assert.equal(s.needsAttention, true);
});

test('the ones needing a look come first; a name with no id joins the person with that name', () => {
  const R = { key: String(RIYA), id: String(RIYA), name: 'Riya' };
  const rows = qualityByArtist([
    work([R], submitted({ overall: 5 })),
    work([{ key: 'n:riya', id: '', name: 'Riya' }], submitted({ overall: 4 })),
    work([N], submitted({ overall: 3 })),
  ]);
  assert.deepEqual(rows.map((r) => r.name), ['Nihala', 'Riya']);
  assert.equal(rows.find((r) => r.name === 'Riya').reviewed, 2, 'one person, not two');
  assert.equal(rows.find((r) => r.name === 'Riya').key, String(RIYA));
  assert.equal(artistKey('', ' Old Name '), 'n:old name');
});

test('an area at 4 stars or more is not a weakness; NPS from the answers', () => {
  const rows = qualityByArtist([work([N], submitted({ nps: 10 })), work([N], submitted({ nps: 6 }))]);
  assert.equal(rows[0].weakest, null);
  assert.equal(rows[0].nps, 0, 'one promoter, one detractor');
});

test('the totals count each work once; worst first puts complaints, then the lowest, then the waiting ones', () => {
  const ws = [work([N, S], submitted({ overall: 4 })), work([N], submitted({ overall: 2 })), work([S], submitted({ overall: 5, complaint: true })), work([N], { status: 'pending' })];
  const t = qualityTotals(ws);
  assert.deepEqual([t.works, t.reviewed, t.waiting, t.complaints, t.low, t.great, t.avgScore], [4, 3, 1, 1, 1, 1, 3.7]);
  const order = [...ws].sort(worstFirst).map((w) => (w.review.status === 'pending' ? 'waiting' : w.review.complaint ? 'complaint' : w.review.score));
  assert.deepEqual(order, ['complaint', 2, 4, 'waiting']);
});
