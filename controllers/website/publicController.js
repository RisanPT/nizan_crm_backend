// Public, read-only endpoints for the Team N Makeovers website.
// Mounted at /api/website/public — no login. Nothing here writes to the database.
import ServicePackage from '../../models/Package.js';
import AddonService from '../../models/AddonService.js';
import Booking from '../../models/Booking.js';
import BlockedDate from '../../models/BlockedDate.js';
import SlotCapacity from '../../models/SlotCapacity.js';
import SlotHold from '../../models/SlotHold.js';
import WebsiteSection from '../../models/WebsiteSection.js';
import WebsiteGalleryItem from '../../models/WebsiteGalleryItem.js';
import Region from '../../models/Region.js';
import District from '../../models/District.js';
import { GALLERY_CATEGORIES, SECTION_KEYS } from '../../config/websiteSections.js';
import { todayIst } from '../../utils/istDate.js';
import { createTtlCache } from '../../utils/ttlCache.js';
import {
  buildDayStatuses,
  dayRange,
  isAllowedMonth,
  monthRange,
} from '../../utils/websiteAvailability.js';
import {
  sortForWebsite,
  toPublicAddon,
  toPublicGalleryItem,
  toPublicLocations,
  toPublicPackage,
} from '../../utils/websitePublic.js';

const DEFAULT_CAPACITY = { morning: 3, evening: 3 }; // same fallback as the CRM
const GALLERY_LIMIT = 200;

const contentCache = createTtlCache({ ttlMs: 60_000, maxEntries: 20 });
const availabilityCache = createTtlCache({ ttlMs: 30_000, maxEntries: 100 });

// Called by the admin side (P2) after publish so the site updates at once.
export const clearPublicCache = () => {
  contentCache.clear();
  availabilityCache.clear();
};

// no-cache: the browser always asks again, so a Publish in the CRM shows at once.
// (The server keeps its own short cache, cleared on every publish.)
const cacheFor = (res) => res.set('Cache-Control', 'no-cache');

// @route GET /api/website/public/content
// All published sections: { sections: { hero: {...}, ... }, updatedAt }
export const getContent = async (req, res) => {
  let body = contentCache.get('content');
  if (!body) {
    const rows = await WebsiteSection.find({ key: { $in: SECTION_KEYS }, published: { $ne: null } })
      .select('key published publishedAt')
      .lean();
    const sections = {};
    let updatedAt = null;
    for (const r of rows) {
      sections[r.key] = r.published;
      if (r.publishedAt && (!updatedAt || r.publishedAt > updatedAt)) updatedAt = r.publishedAt;
    }
    body = { sections, updatedAt };
    contentCache.set('content', body);
  }
  cacheFor(res);
  res.json(body);
};

// @route GET /api/website/public/gallery?category=makeup
export const getGallery = async (req, res) => {
  const { category } = req.query;
  const filter = { active: true };
  if (category !== undefined && category !== '' && category !== 'all') {
    if (!GALLERY_CATEGORIES.some((c) => c.key === category)) {
      return res.status(400).json({ message: 'Unknown gallery category' });
    }
    filter.category = category;
  }
  const items = await WebsiteGalleryItem.find(filter)
    .sort({ sortOrder: 1, createdAt: -1 })
    .limit(GALLERY_LIMIT)
    .select('image alt title description category featuredOnHome')
    .lean();
  cacheFor(res);
  res.json({ categories: GALLERY_CATEGORIES, items: items.map(toPublicGalleryItem) });
};

// @route GET /api/website/public/packages
// Only packages / add-ons switched on for the website. Prices come from the CRM.
export const getPackages = async (req, res) => {
  let body = contentCache.get('packages');
  if (!body) {
    const [packages, addons] = await Promise.all([
      ServicePackage.find({ 'website.show': true })
        .select('name price advanceAmount description sortOrder website regionPrices districtPrices')
        .lean(),
      AddonService.find({ status: 'active', 'website.show': true })
        .select('name price description website')
        .lean(),
    ]);
    body = {
      packages: sortForWebsite(packages).map(toPublicPackage),
      addons: sortForWebsite(addons).map(toPublicAddon),
    };
    contentCache.set('packages', body);
  }
  cacheFor(res);
  res.json(body);
};

// @route GET /api/website/public/locations
// Active regions → active districts (names only), so the bride can pick where
// the wedding is and see that location's package price.
export const getLocations = async (req, res) => {
  let body = contentCache.get('locations');
  if (!body) {
    const [regions, districts] = await Promise.all([
      Region.find({ status: 'active' }).select('name').lean(),
      District.find({ status: 'active' }).select('name region').lean(),
    ]);
    body = { regions: toPublicLocations(regions, districts) };
    contentCache.set('locations', body);
  }
  cacheFor(res);
  res.json(body);
};

// Reads everything that decides availability for [start, end). Read-only:
// unlike /api/slots, a missing default capacity row is NOT created here.
const loadDayStatuses = async ({ start, end }) => {
  const startIso = start.toISOString().slice(0, 10);
  const endIso = end.toISOString().slice(0, 10);
  const [def, overrides, blocked, bookings, holds] = await Promise.all([
    SlotCapacity.findOne({ date: null }).select('morning evening').lean(),
    SlotCapacity.find({ date: { $gte: start, $lt: end } }).select('date morning evening').lean(),
    BlockedDate.find({ active: true, date: { $gte: start, $lt: end } }).select('date').lean(),
    Booking.find({ bookingDate: { $gte: start, $lt: end } }).select('bookingDate eventSlot status').lean(),
    SlotHold.find({
      status: 'active',
      expiresAt: { $gt: new Date() },
      dateStr: { $gte: startIso, $lt: endIso },
    })
      .select('dateStr slot')
      .lean(),
  ]);

  return buildDayStatuses({
    start,
    end,
    defaults: {
      morning: def?.morning ?? DEFAULT_CAPACITY.morning,
      evening: def?.evening ?? DEFAULT_CAPACITY.evening,
    },
    overrides,
    blockedDates: blocked.map((b) => b.date),
    bookings,
    holds,
    todayIso: todayIst(),
  });
};

// @route GET /api/website/public/availability?month=YYYY-MM
// { month, days: { 'YYYY-MM-DD': { status, morning: { status }, evening: { status } } } }
// status: available | few | full | blocked | past
export const getAvailabilityMonth = async (req, res) => {
  const month = String(req.query.month || todayIst().slice(0, 7));
  if (!isAllowedMonth(month, todayIst())) {
    return res.status(400).json({ message: 'month must be YYYY-MM, from this month up to 18 months ahead' });
  }
  let days = availabilityCache.get(month);
  if (!days) {
    days = await loadDayStatuses(monthRange(month));
    availabilityCache.set(month, days);
  }
  cacheFor(res);
  res.json({ month, days });
};

// @route GET /api/website/public/availability/:date   (YYYY-MM-DD)
export const getAvailabilityDate = async (req, res) => {
  const { date } = req.params;
  const range = dayRange(date);
  if (!range || !isAllowedMonth(date.slice(0, 7), todayIst())) {
    return res.status(400).json({ message: 'date must be YYYY-MM-DD, within the next 18 months' });
  }
  const days = await loadDayStatuses(range);
  res.set('Cache-Control', 'no-store'); // checked right before booking, keep it fresh
  res.json({ date, ...days[date] });
};
