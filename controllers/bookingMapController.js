import Booking from '../models/Booking.js';
import { regionScopedMatch } from '../utils/geoScope.js';
import { makeCountsTowardSales } from '../utils/salesRules.js';
import { pincodeOf, coordsForPincodes } from '../utils/geocode.js';

// ── Booking Map ──────────────────────────────────────────────────────────────
// Groups bookings by place (pincode; district when there is none) with booking
// counts, sales and a service-type split, plus coordinates for the map.
// Pincode coordinates come from OpenStreetMap (cached, looked up in the
// background); until a pincode is located its bookings sit at the district
// centre and are flagged `approximate`.

// District centres — fallback when a booking has no locatable pincode.
const DISTRICT_COORDS = {
  kasaragod: [12.5102, 74.9852], kasargod: [12.5102, 74.9852],
  kannur: [11.8745, 75.3704],
  kozhikode: [11.2588, 75.7804], calicut: [11.2588, 75.7804],
  wayanad: [11.6854, 76.132],
  malappuram: [11.0722, 76.074],
  palakkad: [10.7867, 76.6548],
  thrissur: [10.5276, 76.2144], trichur: [10.5276, 76.2144],
  ernakulam: [9.9816, 76.2999], kochi: [9.9816, 76.2999], cochin: [9.9816, 76.2999],
  idukki: [9.85, 76.97],
  kottayam: [9.5916, 76.5224],
  alappuzha: [9.4981, 76.3388], alleppey: [9.4981, 76.3388],
  pathanamthitta: [9.2648, 76.787],
  kollam: [8.8932, 76.6141],
  thiruvananthapuram: [8.5241, 76.9366], trivandrum: [8.5241, 76.9366],
};

const districtCoords = (name) => {
  // Normalise common spelling variants first ("Kozhikkode" → "kozhikode").
  const n = String(name ?? '')
    .toLowerCase()
    .replace(/kk/g, 'k')
    .replace(/\s+/g, '');
  for (const [k, v] of Object.entries(DISTRICT_COORDS)) {
    if (n.includes(k)) return v;
  }
  return null;
};

// Service type = the booked package (Airbrush, Platinum, Custom Package…).
// Spelling/case variants merge ("airbrush" → "Airbrush"); short codes used in
// the data map to their package via SERVICE_ALIASES.
const SERVICE_ALIASES = {
  ab: 'Airbrush', // confirmed by the business
  pt: 'Platinum',
};
export const serviceTypeOf = (service) => {
  const s = String(service ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return 'Not specified';
  const alias = SERVICE_ALIASES[s.toLowerCase()];
  if (alias) return alias;
  // Package families, tolerant of typos ("Airbush Packge", "Platinum Pcakge").
  const flat = s.toLowerCase().replace(/[^a-z]/g, '');
  if (/air(b|br)?u?s?h/.test(flat) && /air/.test(flat)) return 'Airbrush';
  if (/platin/.test(flat)) return 'Platinum';
  if (/royal/.test(flat)) return 'Team N Royal';
  if (/custom/.test(flat)) return 'Custom Package';
  // Title-case so case variants merge.
  return s
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\b(Ab|Pt)\b/g, (m) => m.toUpperCase());
};

const DEAD = ['cancelled', 'canceled', 'rejected', 'postponed'];

// @route GET /api/bookings/map?from=YYYY-MM-DD&to=YYYY-MM-DD&basis=event|added
export const getBookingMap = async (req, res) => {
  try {
    const basis = req.query.basis === 'added' ? 'createdAt' : 'bookingDate';
    const range = {};
    if (req.query.from) range.$gte = new Date(`${req.query.from}T00:00:00+05:30`);
    if (req.query.to) range.$lte = new Date(`${req.query.to}T23:59:59.999+05:30`);

    const geo = await regionScopedMatch(req.user);
    const match = { ...geo };
    if (Object.keys(range).length) match[basis] = range;

    const [bookings, counts] = await Promise.all([
      Booking.find(match)
        .select('service bookingItems.service totalPrice pincode address district region status createdBy')
        .lean(),
      makeCountsTowardSales(),
    ]);

    const live = bookings.filter((b) => !DEAD.includes(String(b.status ?? '').toLowerCase()));

    // Resolve every booking's pincode first, then fetch cached coordinates.
    const pins = live.map((b) => pincodeOf(b));
    const { coords, pending } = await coordsForPincodes(pins);

    const places = new Map();
    const types = new Map();
    const unmapped = { bookings: 0, sales: 0 };
    const totals = { bookings: 0, sales: 0 };

    live.forEach((b, i) => {
      const pin = pins[i];
      const sale = counts(b) ? Number(b.totalPrice) || 0 : 0;
      const service = b.bookingItems?.[0]?.service || b.service || '';
      const type = serviceTypeOf(service);
      totals.bookings += 1;
      totals.sales += sale;

      const t = types.get(type) ?? { name: type, bookings: 0, sales: 0, services: new Map() };
      t.bookings += 1;
      t.sales += sale;
      const svc = String(service).trim() || '—';
      t.services.set(svc, (t.services.get(svc) ?? 0) + 1);
      types.set(type, t);

      // Place: exact pincode coords → district centre (approximate) → unmapped.
      const pc = pin ? coords.get(pin) : null;
      const dc = districtCoords(b.district) ?? districtCoords(b.region);
      let key;
      let point;
      let approximate = false;
      if (pc) {
        key = `pin:${pin}`;
        point = pc;
      } else if (dc) {
        // District fallback keyed by its centre, so spelling variants
        // ("Kozhikode" / "Kozhikkode") merge into one place.
        key = pin ? `pin:${pin}` : `district:${dc[0]},${dc[1]}`;
        point = { lat: dc[0], lng: dc[1] };
        approximate = true;
      } else {
        unmapped.bookings += 1;
        unmapped.sales += sale;
        return;
      }

      const p = places.get(key) ?? {
        key,
        pincode: pin || '',
        label: pc?.label || '',
        district: String(b.district || b.region || pc?.district || '').trim(),
        lat: point.lat,
        lng: point.lng,
        approximate,
        bookings: 0,
        sales: 0,
        types: {},
      };
      p.bookings += 1;
      p.sales += sale;
      const pt = p.types[type] ?? { bookings: 0, sales: 0 };
      pt.bookings += 1;
      pt.sales += sale;
      p.types[type] = pt;
      places.set(key, p);
    });

    res.json({
      basis: basis === 'createdAt' ? 'added' : 'event',
      totals: { ...totals, places: places.size },
      places: [...places.values()].sort((a, b) => b.bookings - a.bookings),
      types: [...types.values()]
        .sort((a, b) => b.bookings - a.bookings)
        .map((t) => ({
          name: t.name,
          bookings: t.bookings,
          sales: t.sales,
          topServices: [...t.services.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6)
            .map(([name, n]) => ({ name, bookings: n })),
        })),
      unmapped,
      // Pincodes still being located — the app can refresh shortly.
      pendingGeocodes: pending,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
