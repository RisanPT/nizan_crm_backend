// The gallery's link to the WORK behind each photo / video and the client's review of it (utils/workReview.js has the rules).
// A gallery item belongs to a work through its own booking (an artist's footage, or a booking picked in the editor), else through
// the shoot it was added from, when that shoot covers a booking. The review is the one the CRM sends the client the morning after the
// work (models/Review.js), matched by the booking.
import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import Review from '../models/Review.js';
import MarketingAsset from '../models/MarketingAsset.js';
import MarketingShoot from '../models/MarketingShoot.js';
import { workView, workTeam, reviewView, reviewFiltersOf, REVIEW_FILTERS, qualityByArtist, qualityTotals, worstFirst, artistKey } from '../utils/workReview.js';
import { istStart, istEnd } from '../utils/istDate.js';

const idOf = (v) => (v == null ? '' : String(v._id ?? v));
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const WORK_BOOKING_FIELDS = 'bookingNumber customerName selectedDates bookingDate service district address status assignedStaff bookingItems.service bookingItems.selectedDates bookingItems.assignedStaff';
const REVIEW_FIELDS = '-token -flagHistory -customerPhone -autoMessageId -autoSendError';

/** The booking of each shoot that covers one (shoot id → booking id). */
const shootBookings = async (shootIds) => {
  const ids = [...new Set(shootIds.filter(Boolean).map(String))];
  if (!ids.length) return new Map();
  const shoots = await MarketingShoot.find({ _id: { $in: ids }, bookingId: { $ne: null } }).select('bookingId').lean();
  return new Map(shoots.map((s) => [idOf(s), idOf(s.bookingId)]));
};

/** The work (booking id) a gallery item belongs to: its own booking, else its shoot's. '' = none. */
const bookingOf = (asset, byShoot) => (asset.bookingId ? idOf(asset.bookingId) : asset.shootId ? byShoot.get(idOf(asset.shootId)) ?? '' : '');

/** Each review that counts for a booking: the latest answered one, else the latest sent. */
const pickReviews = (reviews) => {
  const out = new Map();
  for (const r of reviews) {
    const b = idOf(r.booking);
    const had = out.get(b);
    if (!had || (had.status !== 'submitted' && r.status === 'submitted')) out.set(b, r);
  }
  return out;
};

/** The bookings and their reviews (booking id → { booking, review }). */
export const loadWorks = async (bookingIds) => {
  const ids = [...new Set(bookingIds.filter((x) => x && mongoose.isValidObjectId(x)).map(String))];
  if (!ids.length) return new Map();
  const [bookings, reviews] = await Promise.all([
    Booking.find({ _id: { $in: ids } }).select(WORK_BOOKING_FIELDS).lean(),
    Review.find({ booking: { $in: ids }, status: { $in: ['submitted', 'pending'] } }).select(REVIEW_FIELDS).sort({ createdAt: -1 }).lean(),
  ]);
  const byReview = pickReviews(reviews);
  const out = new Map();
  for (const b of bookings) out.set(idOf(b), { booking: b, review: byReview.get(idOf(b)) ?? null });
  return out;
};

/** The work each gallery item came from (asset id → workView), for the items that have one. */
export const workOfAssets = async (assets) => {
  const byShoot = await shootBookings(assets.filter((a) => !a.bookingId && a.shootId).map((a) => idOf(a.shootId)));
  const works = await loadWorks(assets.map((a) => bookingOf(a, byShoot)));
  const out = new Map();
  for (const a of assets) {
    const w = works.get(bookingOf(a, byShoot));
    if (w) out.set(idOf(a), workView(w.booking, w.review, { workDay: a.workDay ?? '' }));
  }
  return out;
};

/** The gallery items of these works: their own booking is one of them, or (with no booking of their own) their shoot covers one. */
const assetsOfBookings = async (bookingIds) => {
  const ids = [...new Set(bookingIds.map(String))].filter((x) => mongoose.isValidObjectId(x));
  if (!ids.length) return { _id: { $exists: false } }; // nothing can match
  const shoots = await MarketingShoot.find({ bookingId: { $in: ids } }).select('_id').lean();
  return { $or: [{ bookingId: { $in: ids.map(oid) } }, ...(shoots.length ? [{ bookingId: null, shootId: { $in: shoots.map((s) => s._id) } }] : [])] };
};

/** The bookings an artist was on (key = employee id, or "n:name" for a name with no id) — the booking now and the team reviewed. */
const bookingsOfArtists = async (keys) => {
  const ids = keys.filter((k) => mongoose.isValidObjectId(k)).map(oid);
  const names = keys.filter((k) => k.startsWith('n:')).map((k) => new RegExp(`^\\s*${escapeRx(k.slice(2))}\\s*$`, 'i'));
  const or = [];
  if (ids.length) or.push({ 'assignedStaff.employeeId': { $in: ids } }, { 'bookingItems.assignedStaff.employeeId': { $in: ids } });
  if (names.length) or.push({ 'assignedStaff.artistName': { $in: names } }, { 'bookingItems.assignedStaff.artistName': { $in: names } });
  const rOr = [];
  if (ids.length) rOr.push({ artistIds: { $in: ids } }, { 'teamMembers.employeeId': { $in: ids } });
  if (names.length) rOr.push({ artistNames: { $in: names } }, { 'teamMembers.name': { $in: names } });
  const [bookings, reviews] = await Promise.all([
    or.length ? Booking.find({ $or: or }).select('_id').lean() : [],
    rOr.length ? Review.find({ $or: rOr, booking: { $ne: null } }).select('booking').lean() : [],
  ]);
  return [...bookings.map(idOf), ...reviews.map((r) => idOf(r.booking))];
};

/** The bookings whose review falls under any of these filters ('great' 'good' 'low' 'complaint' 'waiting'). */
const bookingsOfReviewFilters = async (values) => {
  const statuses = [...(values.some((v) => v !== 'waiting') ? ['submitted'] : []), ...(values.includes('waiting') ? ['pending'] : [])];
  const reviews = await Review.find({ status: { $in: statuses }, booking: { $ne: null } }).select('booking status overall brideScore teamMemberScore complaint').sort({ createdAt: -1 }).lean();
  const picked = pickReviews(reviews);
  return [...picked.entries()].filter(([, r]) => reviewFiltersOf(r).some((f) => values.includes(f))).map(([b]) => b);
};

/** The gallery's two work filters as asset filters: `artist` (keys) and `review` (REVIEW_FILTERS). null = not asked. */
export const workClauses = async ({ artist = [], review = [] } = {}) => {
  const asked = review.filter((v) => REVIEW_FILTERS.includes(v));
  const [byArtist, byReview] = await Promise.all([artist.length ? bookingsOfArtists(artist) : null, asked.length ? bookingsOfReviewFilters(asked) : null]);
  return {
    artist: byArtist ? await assetsOfBookings(byArtist) : null,
    review: byReview ? await assetsOfBookings(byReview) : null,
  };
};

/** Gallery items that belong to some work — what the two work facets count. */
export const LINKED = { $or: [{ bookingId: { $ne: null } }, { shootId: { $ne: null } }] };

/**
 * The numbers next to the Artist and Client review filters. [artistRows] / [reviewRows] = the matching gallery items grouped by
 * { b: bookingId, s: shootId } with `n` (each counted with every filter but its own). → { artists: [{key, name, count}], reviews }.
 */
export const workFacets = async (artistRows, reviewRows) => {
  const all = [...artistRows, ...reviewRows];
  const byShoot = await shootBookings(all.filter((r) => !r._id?.b && r._id?.s).map((r) => idOf(r._id.s)));
  const bookingOfRow = (r) => (r._id?.b ? idOf(r._id.b) : r._id?.s ? byShoot.get(idOf(r._id.s)) ?? '' : '');
  const works = await loadWorks(all.map(bookingOfRow));
  const artists = new Map();
  for (const r of artistRows) {
    const w = works.get(bookingOfRow(r));
    if (!w) continue;
    for (const a of workTeam(w.booking, w.review)) {
      const had = artists.get(a.key) ?? { key: a.key, name: a.name, count: 0 };
      had.count += r.n;
      artists.set(a.key, had);
    }
  }
  const reviews = Object.fromEntries(REVIEW_FILTERS.map((f) => [f, 0]));
  for (const r of reviewRows) {
    const w = works.get(bookingOfRow(r));
    for (const f of reviewFiltersOf(w?.review)) reviews[f] += r.n;
  }
  return { artists: [...artists.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)), reviews };
};

/** How many gallery items each work has (booking id → count). */
const assetCounts = async (bookingIds) => {
  const ids = bookingIds.filter((x) => mongoose.isValidObjectId(x)).map(oid);
  if (!ids.length) return new Map();
  const shoots = await MarketingShoot.find({ bookingId: { $in: ids } }).select('bookingId').lean();
  const shootBooking = new Map(shoots.map((s) => [idOf(s), idOf(s.bookingId)]));
  const rows = await MarketingAsset.aggregate([
    { $match: { $or: [{ bookingId: { $in: ids } }, ...(shoots.length ? [{ bookingId: null, shootId: { $in: shoots.map((s) => s._id) } }] : [])] } },
    { $group: { _id: { b: '$bookingId', s: '$shootId' }, n: { $sum: 1 } } },
  ]);
  const out = new Map();
  for (const r of rows) {
    const b = r._id.b ? idOf(r._id.b) : shootBooking.get(idOf(r._id.s)) ?? '';
    if (b) out.set(b, (out.get(b) ?? 0) + r.n);
  }
  return out;
};

/**
 * The works of the event days [from]–[to] ('YYYY-MM-DD') whose client was sent a review (answered or not), each as a workView with
 * `assets` (its gallery items). A review with no event date counts by the day it was sent.
 */
export const worksInPeriod = async (from, to) => {
  const a = istStart(from);
  const z = istEnd(to);
  const reviews = await Review.find({
    status: { $in: ['submitted', 'pending'] },
    $or: [{ weddingDate: { $gte: a, $lte: z } }, { weddingDate: null, sentAt: { $gte: a, $lte: z } }],
  })
    .select(REVIEW_FIELDS)
    .sort({ createdAt: -1 })
    .lean();
  const withBooking = reviews.filter((r) => r.booking);
  const byBooking = pickReviews(withBooking);
  const bookingIds = [...byBooking.keys()];
  const [bookings, counts] = await Promise.all([Booking.find({ _id: { $in: bookingIds } }).select(WORK_BOOKING_FIELDS).lean(), assetCounts(bookingIds)]);
  const bookingById = new Map(bookings.map((b) => [idOf(b), b]));
  const works = [...byBooking.entries()].map(([b, r]) => ({ ...workView(bookingById.get(b) ?? null, r), bookingId: b, assets: counts.get(b) ?? 0 }));
  // a review kept with no booking (an old one) still counts, by its own record of the team
  for (const r of reviews.filter((x) => !x.booking)) works.push({ ...workView(null, r), assets: 0 });
  return works;
};

/** The quality view of [from]–[to]: the figures over every work, and each artist's. */
export const qualityReport = async (from, to) => {
  const works = await worksInPeriod(from, to);
  return { from, to, totals: qualityTotals(works), artists: qualityByArtist(works) };
};

/** One artist's works in [from]–[to], the ones needing a look first, with up to [perWork] of each work's gallery items. */
export const artistWorks = async (key, from, to, { perWork = 8 } = {}) => {
  const works = await worksInPeriod(from, to);
  const rows = qualityByArtist(works);
  const row = rows.find((r) => r.key === key) ?? null;
  if (!row) return { artist: null, works: [] };
  // the same joining of names to ids as the rows: a work counts when it names this person by id or by name
  const name = row.name.toLowerCase();
  const mine = works.filter((w) => (w.artists ?? []).some((a) => (row.id && a.id === row.id) || artistKey(a.id, a.name) === key || (!a.id && a.name.toLowerCase() === name))).sort(worstFirst);
  const ids = mine.map((w) => w.bookingId).filter((x) => mongoose.isValidObjectId(x));
  const shoots = ids.length ? await MarketingShoot.find({ bookingId: { $in: ids } }).select('bookingId').lean() : [];
  const shootBooking = new Map(shoots.map((s) => [idOf(s), idOf(s.bookingId)]));
  const assets = ids.length
    ? await MarketingAsset.find({ $or: [{ bookingId: { $in: ids.map(oid) } }, ...(shoots.length ? [{ bookingId: null, shootId: { $in: shoots.map((s) => s._id) } }] : [])] })
        .sort({ createdAt: -1 })
        .lean()
    : [];
  const byBooking = new Map();
  for (const x of assets) {
    const b = x.bookingId ? idOf(x.bookingId) : shootBooking.get(idOf(x.shootId)) ?? '';
    if (!b) continue;
    const list = byBooking.get(b) ?? [];
    if (list.length < perWork) list.push(x);
    byBooking.set(b, list);
  }
  return { artist: row, works: mine.map((w) => ({ ...w, items: byBooking.get(w.bookingId) ?? [] })) };
};

export { reviewView };
