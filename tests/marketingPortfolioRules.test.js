// Pure unit tests: node --test tests/marketingPortfolioRules.test.js
// The Creative Portfolio rules added after the audit: published posts linked to a shoot are delivered outputs (counted once with the
// asset they were made from), turnaround runs to the day the last output was approved or went out, a shoot's content checklist,
// which makeup artists are on a client work that day, crew availability with attendance and artists, the storyboard and the booking.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../utils/marketingPortfolioStats.js';
import { cleanShootInput, cleanStoryboard } from '../utils/marketingPortfolioInput.js';

let n = 0;
const shoot = (extra = {}) => ({ _id: `s${++n}`, title: `Shoot ${n}`, brand: 'main', status: 'planned', shootDate: '2026-11-10', crew: [], planned: {}, milestones: [], ...extra });
const asset = (extra = {}) => ({ _id: `a${++n}`, shootId: 's0', kind: 'reel', stage: 'approved', isFinal: false, tags: [], sizeMb: 0, createdAt: '2026-11-11T05:00:00Z', ...extra });
const post = (extra = {}) => ({ _id: `p${++n}`, shootId: 's0', title: 'Post', contentType: 'reel', status: 'published', scheduledDate: '2026-11-13T05:00:00Z', publishedDate: '2026-11-13T05:00:00Z', assetId: null, ...extra });

test('a published post linked to the shoot is a delivered output, by its format; anything not out is not', () => {
  assert.equal(P.outputKeyOf(P.postAsOutput(post())), 'reels');
  assert.equal(P.outputKeyOf(P.postAsOutput(post({ contentType: 'trial_reel' }))), 'reels');
  assert.equal(P.outputKeyOf(P.postAsOutput(post({ contentType: 'story' }))), 'storyFrames');
  assert.equal(P.outputKeyOf(P.postAsOutput(post({ contentType: 'carousel' }))), 'carousels');
  assert.equal(P.outputKeyOf(P.postAsOutput(post({ contentType: 'post' }))), 'stills');
  assert.equal(P.outputKeyOf(P.postAsOutput(post({ contentType: 'video' }))), 'films');
  assert.equal(P.postAsOutput(post({ contentType: 'blog' })), null, 'a blog is not one of the planned outputs');
  for (const status of ['idea', 'planned', 'in-progress', 'in-review', 'scheduled', 'cancelled']) assert.equal(P.postAsOutput(post({ status })), null, status);
});

test('a post made from one of the shoot\'s delivered assets is that asset going out — counted once', () => {
  const reel = asset({ _id: 'a-reel' });
  const merged = P.mergeOutputs([reel], [post({ assetId: 'a-reel' }), post({ contentType: 'story' })]);
  assert.deepEqual(P.deliveredOf(merged), { reels: 1, stills: 0, films: 0, carousels: 0, storyFrames: 1, decks: 0 });
  // the asset was sent back: the post that went out is still a delivery
  const back = P.mergeOutputs([asset({ _id: 'a-back', stage: 'in_edit' })], [post({ assetId: 'a-back' })]);
  assert.equal(P.deliveredTotal(back), 1);
  // grouped by shoot
  const by = P.assetsByShoot([asset({ shootId: 'sA' })], [post({ shootId: 'sA', contentType: 'post' }), post({ shootId: 'sB' }), post({ shootId: null })]);
  assert.equal(P.deliveredTotal(by.get('sA')), 2);
  assert.equal(P.deliveredTotal(by.get('sB')), 1, 'a shoot with only posts still has a list');
  assert.equal(by.size, 2, 'a post with no shoot belongs to none');
});

test('turnaround runs from the shoot date to the day the LAST output was approved or went out', () => {
  const s = shoot({ planned: { reels: 2 } });
  // added on the 11th but approved on the 14th: the approval is what counts
  assert.equal(P.turnaroundDays(s, [asset({ approvedAt: '2026-11-14T05:00:00Z' }), asset({ approvedAt: '2026-11-12T05:00:00Z' })]), 4);
  // an asset approved before approvals were recorded falls back to the day it was added
  assert.equal(P.turnaroundDays(s, [asset({ approvedAt: null, createdAt: '2026-11-11T05:00:00Z' }), asset({ approvedAt: null, createdAt: '2026-11-12T05:00:00Z' })]), 2);
  // one reel approved, the second delivered as a post that went out on the 16th
  assert.equal(P.turnaroundDays(s, P.mergeOutputs([asset({ approvedAt: '2026-11-12T05:00:00Z' })], [post({ publishedDate: '2026-11-16T05:00:00Z' })])), 6);
  assert.equal(P.turnaroundDays(s, P.mergeOutputs([asset()], [post({ status: 'scheduled' })])), null, '1 of 2 delivered: not yet');
});

test('the report row says how many of the delivered outputs were posts; footage never counts a post', () => {
  const s = shoot({ planned: { reels: 1, stills: 1 } });
  const r = P.reportRow(s, P.mergeOutputs([asset({ sizeMb: 500 })], [post({ contentType: 'image' })]));
  assert.equal(r.deliveredTotal, 2);
  assert.equal(r.deliveredPosts.stills, 1);
  assert.equal(r.deliveredPosts.reels, 0);
  assert.equal(r.onTrack, true);
  const k = P.reportKpis([{ ...s, _id: 's0' }], P.assetsByShoot([asset({ sizeMb: 1024 })], [post()]), { from: '2026-11-01', to: '2026-11-30', brand: 'all' });
  assert.equal(k.footageGb, 1);
  assert.equal(k.outputs, 2);
});

test('content checklist: planned against delivered (each once) and posted, done when delivered reaches planned', () => {
  const s = shoot({ planned: { reels: 2, stills: 1 } });
  const list = P.contentChecklist(s, [asset({ _id: 'r1' }), asset({ kind: 'still', stage: 'raw' })], [post({ assetId: 'r1' }), post({ contentType: 'carousel' })]);
  const by = Object.fromEntries(list.map((r) => [r.key, r]));
  assert.deepEqual(by.reels, { key: 'reels', label: 'Reels', planned: 2, delivered: 1, posted: 1, done: false }, 'the reel and its post are one delivery');
  assert.deepEqual(by.stills, { key: 'stills', label: 'Stills / Photos', planned: 1, delivered: 0, posted: 0, done: false }, 'a raw still is not delivered');
  assert.deepEqual(by.carousels, { key: 'carousels', label: 'Carousel', planned: 0, delivered: 1, posted: 1, done: true }, 'delivered without being planned is shown too');
  assert.equal(by.films, undefined, 'nothing planned or delivered → not listed');
  assert.deepEqual(P.contentChecklist(shoot(), [], []), []);
});

test('makeup artists on a client work: the booking\'s artists on its days, a package\'s artists on the package\'s days; never the driver', () => {
  const day = '2026-11-20';
  const b = (extra) => ({ status: 'confirmed', selectedDates: [day], assignedStaff: [], bookingItems: [], ...extra });
  const busy = P.artistsOnWorkDay([
    b({ assignedStaff: [{ employeeId: 'e1', roleType: 'lead' }, { employeeId: 'd1', roleType: 'driver' }] }),
    b({ selectedDates: ['2026-11-19', day], bookingItems: [{ selectedDates: ['2026-11-19'], assignedStaff: [{ employeeId: 'e2' }] }, { selectedDates: [day], assignedStaff: [{ employeeId: 'e3' }] }] }),
    b({ selectedDates: [], serviceStart: '2026-11-20T04:00:00Z', assignedStaff: [{ employeeId: 'e4' }] }),
    b({ selectedDates: [], bookingDate: '2026-11-20T10:00:00Z', bookingItems: [{ assignedStaff: [{ employeeId: 'e5' }] }] }),
    b({ status: 'Cancelled', assignedStaff: [{ employeeId: 'e6' }] }),
    b({ status: 'postponed', assignedStaff: [{ employeeId: 'e7' }] }),
    b({ selectedDates: ['2026-11-21'], assignedStaff: [{ employeeId: 'e8' }] }),
  ], day);
  assert.deepEqual([...busy].sort(), ['e1', 'e3', 'e4', 'e5']);
  assert.deepEqual(P.bookingDays({ selectedDates: ['2026-11-02', 'nope', '2026-11-02'] }), ['2026-11-02']);
  assert.deepEqual(P.bookingDays({ serviceStart: '2026-11-01T20:00:00Z' }), ['2026-11-02'], 'the IST day');
});

test('crew availability: leave, then absent (attendance), then on a shoot, then on a client work — each person once', () => {
  const members = [
    { id: 'v1', employeeId: 'ev1', role: 'Videographer', onLeave: true, absent: true },
    { id: 'v2', employeeId: 'ev2', role: 'Videographer', absent: true },
    { id: 'v3', employeeId: 'ev3', role: 'Videographer' },
    { id: 'mua1', employeeId: 'mua1', role: 'Makeup Artist', onWork: true },
    { id: 'mua2', employeeId: 'mua2', role: 'Makeup Artist', onWork: true },
    { id: 'mua3', employeeId: 'mua3', role: 'Makeup Artist' },
    { id: 'mua4', employeeId: 'mua4', role: 'Makeup Artist' },
  ];
  const day = [shoot({ crew: [{ memberId: 'v3' }, { employeeId: 'mua2', name: 'Anu' }] }), shoot({ status: 'cancelled', crew: [{ employeeId: 'mua3' }] })];
  const a = Object.fromEntries(P.crewAvailability({ members, shootsOnDay: day }).map((r) => [r.role, r]));
  assert.deepEqual(a.Videographer, { role: 'Videographer', total: 3, booked: 1, onLeave: 1, absent: 1, onWork: 0, available: 0 });
  assert.deepEqual(a['Makeup Artist'], { role: 'Makeup Artist', total: 4, booked: 1, onLeave: 0, absent: 0, onWork: 1, available: 2 }, 'an artist on the shoot\'s crew is booked; one on a booking is on a work');
});

test('storyboard: frames in order, each with a description; shot no. defaults to the position; links are https only', () => {
  const ok = cleanStoryboard([{ description: ' Bride enters ', shotType: 'Wide', durationSec: '8', referenceUrl: 'https://d.test/ref' }, { shotNo: '2A', description: 'Close-up of the eyes', notes: 'slow' }]);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, [
    { shotNo: '1', description: 'Bride enters', shotType: 'Wide', durationSec: 8, referenceUrl: 'https://d.test/ref', imageUrl: '', notes: '' },
    { shotNo: '2A', description: 'Close-up of the eyes', shotType: '', durationSec: 0, referenceUrl: '', imageUrl: '', notes: 'slow' },
  ]);
  // a frame's picture (https only) and the key it already had come through; a tick never does (the server owns it)
  const pic = cleanStoryboard([{ key: 'fabc123', description: 'x', imageUrl: 'https://res.cloudinary.com/x/image/upload/a.jpg', shotAt: '2026-01-01', shotByName: 'Me' }]);
  assert.deepEqual(pic.value[0], { key: 'fabc123', shotNo: '1', description: 'x', shotType: '', durationSec: 0, referenceUrl: '', imageUrl: 'https://res.cloudinary.com/x/image/upload/a.jpg', notes: '' });
  assert.match(cleanStoryboard([{ description: 'x', imageUrl: 'data:image/png;base64,AAA' }]).message, /Frame 1: the picture/);
  assert.match(cleanStoryboard([{ description: '' }]).message, /Frame 1 needs a description/);
  assert.match(cleanStoryboard([{ description: 'x' }, { description: 'y', durationSec: -1 }]).message, /Frame 2: the duration/);
  assert.match(cleanStoryboard([{ description: 'x', referenceUrl: 'javascript:alert(1)' }]).message, /https/);
  assert.equal(cleanStoryboard('nope').ok, false);
  assert.equal(cleanStoryboard(Array.from({ length: 101 }, () => ({ description: 'x' }))).ok, false);
  const viaShoot = cleanShootInput({ storyboard: [{ description: 'Detail of the jewellery' }] }, { title: 'x', shootDate: '2026-11-10' });
  assert.equal(viaShoot.value.storyboard.length, 1);
});

test('a shoot\'s booking: an id or nothing; a crew line can name a makeup artist by employee', () => {
  const existing = { title: 'x', shootDate: '2026-11-10' };
  assert.equal(cleanShootInput({ bookingId: '64b7f0c2a1b2c3d4e5f60718' }, existing).value.bookingId, '64b7f0c2a1b2c3d4e5f60718');
  assert.equal(cleanShootInput({ bookingId: null }, existing).value.bookingId, null, 'unlinking');
  assert.equal(cleanShootInput({ bookingId: '' }, existing).value.bookingId, null);
  assert.equal(cleanShootInput({ bookingId: 'not-an-id' }, existing).ok, false);
  assert.equal(cleanShootInput({ title: 'Look' }, existing).value.bookingId, undefined, 'not sent → not changed');
  const crew = cleanShootInput({ crew: [{ employeeId: '64b7f0c2a1b2c3d4e5f60719', name: 'Anu' }, { employeeId: 'bad' }] }, existing).value.crew;
  assert.deepEqual(crew, [{ memberId: null, employeeId: '64b7f0c2a1b2c3d4e5f60719', name: 'Anu', role: '' }], 'a line naming nobody is dropped');
});
