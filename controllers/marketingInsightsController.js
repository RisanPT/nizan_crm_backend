import Review from '../models/Review.js';
import Booking from '../models/Booking.js';
import Employee from '../models/Employee.js';
import SlotCapacity from '../models/SlotCapacity.js';
import BlockedDate from '../models/BlockedDate.js';
import { slotHalf, consumesSlot, dayKey } from '../utils/slots.js';

// Marketing intelligence is read by the marketing team + full-access managers.
const READ_ROLES = ['admin', 'manager', 'marketing_admin', 'crm'];
const canRead = (u) => READ_ROLES.includes(u?.role);

const NON_REVENUE = ['cancelled', 'canceled', 'rejected', 'lost', 'draft'];

// Keyword inference for the Culture segment, used ONLY when Booking.culture is
// blank (read-time, non-destructive — the manual field always wins). Reads what
// was actually booked: package/service name, event slot, and add-on names.
// Tune these patterns to match the studio's real naming (see
// scripts/discover-culture-signals.js for the actual values).
const CULTURE_HINTS = {
  Hindu: /hindu|muhurt|kalyan|mangal|saptapadi|pooja|brahmin|nair|ezhava|thali/i,
  Muslim: /muslim|nikah|nikkah|walima|mappila|islam|mehendi|henna/i,
  Christian: /christ|church|white wedding|nasrani|marthoma|catholic|syrian|jacobite/i,
};
const inferCulture = (b) => {
  const blob = [
    b.service,
    b.eventSlot,
    ...((b.addons || []).map((a) => a.service)),
    ...((b.bookingItems || []).flatMap((it) => [
      it.service,
      it.eventSlot,
      ...((it.addons || []).map((a) => a.service)),
    ])),
  ].join(' ');
  for (const [k, re] of Object.entries(CULTURE_HINTS)) {
    if (re.test(blob)) return k;
  }
  return '';
};
const isLiveBooking = (b) => {
  const s = String(b.status || '').toLowerCase();
  return s !== 'completed' && s !== 'cancelled' && s !== 'canceled' &&
    s !== 'rejected' && s !== 'lost';
};

// Financial-year boundaries (Apr 1 → next Apr 1, exclusive). Mirrors
// services/posting.js fyLabelFor: months Apr(3)–Dec belong to that year's FY.
const currentFyStartYear = (d = new Date()) => {
  const y = d.getUTCFullYear();
  return d.getUTCMonth() >= 3 ? y : y - 1;
};
const fyLabelFor = (startYear) =>
  `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;

const monthKey = (d) => {
  const x = new Date(d);
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}`;
};
const round = (n) => Math.round((Number(n) || 0) * 10) / 10;

// Resolve the [from, to) window: explicit ?from/?to, or ?fy=<startYear>, else
// the current financial year.
const resolveRange = (q) => {
  if (q.from || q.to) {
    const from = q.from ? new Date(q.from) : new Date(Date.UTC(1970, 0, 1));
    const to = q.to ? new Date(q.to) : new Date();
    return { from, to, fyLabel: null };
  }
  const startYear = q.fy ? Number(q.fy) : currentFyStartYear();
  return {
    from: new Date(Date.UTC(startYear, 3, 1)),
    to: new Date(Date.UTC(startYear + 1, 3, 1)),
    fyLabel: fyLabelFor(startYear),
  };
};

// @route GET /api/marketing/insights?from=&to=&fy=
// One payload powering the Marketing Intelligence dashboard: NPS (+ trend),
// CSAT, artist utilization, FY slot utilization, and segment breakdowns.
export const getMarketingInsights = async (req, res) => {
  try {
    if (!canRead(req.user)) {
      return res.status(403).json({ message: 'No marketing access' });
    }
    const { from, to, fyLabel } = resolveRange(req.query);

    // ── 1. NPS + trend + CSAT (submitted reviews in range) ──
    const reviews = await Review.find({
      status: 'submitted',
      submittedAt: { $gte: from, $lt: to },
    })
      .select('nps brideScore teamMemberScore overall submittedAt')
      .lean();

    const npsVals = reviews.filter((r) => r.nps !== null && r.nps !== undefined);
    const npsOf = (rows) => {
      if (!rows.length) return { nps: 0, promoters: 0, passives: 0, detractors: 0, responses: 0 };
      let pro = 0, pas = 0, det = 0;
      for (const r of rows) {
        if (r.nps >= 9) pro++;
        else if (r.nps >= 7) pas++;
        else det++;
      }
      return {
        nps: Math.round(((pro - det) / rows.length) * 100),
        promoters: pro, passives: pas, detractors: det, responses: rows.length,
      };
    };
    const trendMap = new Map(); // month -> rows[]
    for (const r of npsVals) {
      const k = monthKey(r.submittedAt);
      (trendMap.get(k) || trendMap.set(k, []).get(k)).push(r);
    }
    const npsTrend = [...trendMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, rows]) => ({ month, ...npsOf(rows) }));

    const submittedCount = reviews.length;
    const avg = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0);
    const csat = {
      avgBrideScore: round(avg(reviews.map((r) => r.brideScore || 0))),
      avgTeamScore: round(avg(reviews.map((r) => r.teamMemberScore || 0))),
      submitted: submittedCount,
    };

    // ── 2. Artist utilization (live bookings, "now" — not range-scoped) ──
    const liveBookings = await Booking.find({
      status: { $nin: ['completed', 'cancelled', 'canceled', 'rejected', 'lost'] },
    })
      .select('assignedStaff bookingItems.assignedStaff status')
      .lean();
    const busy = new Set();
    for (const b of liveBookings) {
      for (const s of b.assignedStaff || []) {
        if (s.roleType !== 'driver' && s.employeeId) busy.add(String(s.employeeId));
      }
      for (const item of b.bookingItems || []) {
        for (const s of item.assignedStaff || []) {
          if (s.roleType !== 'driver' && s.employeeId) busy.add(String(s.employeeId));
        }
      }
    }
    const activeArtists = await Employee.find({
      status: 'active',
      artistRole: { $in: ['artist', 'assistant'] },
    }).select('_id').lean();
    const artistIds = new Set(activeArtists.map((e) => String(e._id)));
    const busyArtists = [...busy].filter((id) => artistIds.has(id)).length;
    const artistUtilization = {
      pct: activeArtists.length ? Math.round((busyArtists / activeArtists.length) * 100) : 0,
      busy: busyArtists,
      total: activeArtists.length,
    };

    // ── 3. FY slot utilization (booked ÷ capacity over the range) ──
    const slotUtilization = await slotUtilizationForRange(from, to, fyLabel);

    // ── 4. Segments: region, district, timeline (month), culture ──
    const segBookings = await Booking.find({
      bookingDate: { $gte: from, $lt: to },
      status: { $nin: NON_REVENUE },
    })
      .select(
        'region district pincode culture bookingDate totalPrice service eventSlot ' +
          'addons bookingItems.service bookingItems.eventSlot bookingItems.addons'
      )
      .lean();

    const bump = (map, key, revenue) => {
      const k = (key && String(key).trim()) || null;
      const label = k || 'Unknown';
      const cur = map.get(label) || { name: label, bookings: 0, revenue: 0 };
      cur.bookings += 1;
      cur.revenue += Number(revenue) || 0;
      map.set(label, cur);
    };
    const byRegionM = new Map(), byDistrictM = new Map(), byPincodeM = new Map(),
      byMonthM = new Map(), byCultureM = new Map();
    for (const b of segBookings) {
      bump(byRegionM, b.region, b.totalPrice);
      bump(byDistrictM, b.district, b.totalPrice);
      bump(byPincodeM, b.pincode, b.totalPrice);
      bump(byMonthM, monthKey(b.bookingDate), b.totalPrice);
      // Explicit field wins; otherwise infer from what was booked; else blank.
      const culture =
        (b.culture || '').trim() || inferCulture(b) || 'Not specified';
      bump(byCultureM, culture, b.totalPrice);
    }
    const topList = (m, n = 12) =>
      [...m.values()].sort((a, b) => b.bookings - a.bookings).slice(0, n);
    // District/pincode are sparse for legacy imports — drop the "Unknown" bucket
    // so the UI only surfaces real values (with a "not captured" note).
    const knownOnly = (m, n = 12) =>
      [...m.values()]
        .filter((r) => r.name !== 'Unknown')
        .sort((a, b) => b.bookings - a.bookings)
        .slice(0, n);
    const segments = {
      byRegion: topList(byRegionM),
      byDistrict: knownOnly(byDistrictM),
      byPincode: knownOnly(byPincodeM),
      byMonth: [...byMonthM.values()].sort((a, b) => a.name.localeCompare(b.name)),
      byCulture: [...byCultureM.values()].sort((a, b) => b.bookings - a.bookings),
      totalBookings: segBookings.length,
    };

    // ── 5. Coverage: data-quality of the three analytics dimensions across the
    // WHOLE booking dataset (not range-scoped) — surfaces existing bookings that
    // lack a proper event date / culture / location so they can be corrected.
    const coverage = await computeCoverage();

    res.json({
      range: { from, to, fyLabel },
      nps: { ...npsOf(npsVals), trend: npsTrend },
      csat,
      artistUtilization,
      slotUtilization,
      segments,
      coverage,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Data-quality of the three analytics dimensions (event date / culture /
// location) across ALL revenue-bearing bookings. Read-only, non-destructive —
// the manual Booking.culture always wins and event dates are already correct
// where present; this just finds the gaps in existing data so they can be fixed.
const computeCoverage = async () => {
  const rows = await Booking.find({ status: { $nin: NON_REVENUE } })
    .select(
      'customerName bookingDate culture region district pincode service ' +
        'eventSlot addons bookingItems.service bookingItems.eventSlot bookingItems.addons'
    )
    .sort({ bookingDate: -1 })
    .lean();

  const eventDate = { total: rows.length, withDate: 0, missing: 0 };
  const culture = { explicit: 0, inferred: 0, unknown: 0 };
  const location = { withRegion: 0, withDistrict: 0, withPincode: 0, none: 0 };
  const worklist = [];
  const has = (v) => !!(v && String(v).trim());

  for (const b of rows) {
    const missing = [];

    if (b.bookingDate) eventDate.withDate++;
    else { eventDate.missing++; missing.push('eventDate'); }

    if (has(b.culture)) culture.explicit++;
    else if (inferCulture(b)) culture.inferred++;
    else { culture.unknown++; missing.push('culture'); }

    const region = has(b.region), district = has(b.district), pincode = has(b.pincode);
    if (region) location.withRegion++;
    if (district) location.withDistrict++;
    if (pincode) location.withPincode++;
    if (!region && !district && !pincode) { location.none++; missing.push('location'); }

    if (missing.length && worklist.length < 50) {
      worklist.push({
        _id: b._id,
        customerName: b.customerName || '',
        bookingDate: b.bookingDate || null,
        missing,
      });
    }
  }

  return { eventDate, culture, location, worklist };
};

// Sum capacity (override/default, 0 on blocked days) and booked slots across
// [from, to), rolled up per calendar month. Mirrors slotController.getMonth.
const slotUtilizationForRange = async (from, to, fyLabel) => {
  const def = (await SlotCapacity.findOne({ date: null })) || { morning: 3, evening: 3 };
  const overrides = await SlotCapacity.find({ date: { $gte: from, $lt: to } }).lean();
  const capByDay = new Map(overrides.map((o) => [dayKey(o.date).toISOString(), o]));
  const blocked = await BlockedDate.find({ active: true, date: { $gte: from, $lt: to } })
    .select('date').lean();
  const blockedSet = new Set(blocked.map((b) => dayKey(b.date).toISOString()));

  const bookings = await Booking.find({ bookingDate: { $gte: from, $lt: to } })
    .select('bookingDate status').lean();
  const bookedByDay = new Map();
  for (const b of bookings) {
    if (!consumesSlot(b)) continue;
    const k = dayKey(b.bookingDate).toISOString();
    bookedByDay.set(k, (bookedByDay.get(k) || 0) + 1);
  }

  const perMonth = new Map(); // 'YYYY-MM' -> { capacity, booked }
  let totalCapacity = 0, totalBooked = 0;
  const oneDay = 24 * 60 * 60 * 1000;
  // Guard against an unbounded range (cap at ~2 years of days).
  for (let t = from.getTime(); t < to.getTime() && t < from.getTime() + 750 * oneDay; t += oneDay) {
    const day = new Date(t);
    const iso = dayKey(day).toISOString();
    const cap = capByDay.get(iso) || def;
    const dayCap = blockedSet.has(iso) ? 0 : (cap.morning || 0) + (cap.evening || 0);
    const dayBooked = bookedByDay.get(iso) || 0;
    totalCapacity += dayCap;
    totalBooked += dayBooked;
    const mk = monthKey(day);
    const cur = perMonth.get(mk) || { capacity: 0, booked: 0 };
    cur.capacity += dayCap;
    cur.booked += dayBooked;
    perMonth.set(mk, cur);
  }
  const pctOf = (b, c) => (c > 0 ? Math.round((b / c) * 100) : 0);
  return {
    fyLabel,
    totalCapacity,
    totalBooked,
    pct: pctOf(totalBooked, totalCapacity),
    byMonth: [...perMonth.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, v]) => ({ month, ...v, pct: pctOf(v.booked, v.capacity) })),
  };
};

// @route GET /api/marketing/calendar?year=YYYY
// Year-over-year booking comparison calendar for the marketing team. Returns
// per-DAY booking counts + revenue for the selected calendar year AND the
// previous year, so every calendar cell can be compared against the exact same
// date one year earlier (e.g. hover 15 Mar 2026 → shows 15 Mar 2025 too). Built
// on bookingDate (the real EVENT date, not the entry date). Both years are
// fetched in a single query and bucketed by UTC day, matching the rest of the
// app's day-grouping (utils/slots dayKey).
export const getBookingCalendar = async (req, res) => {
  try {
    if (!canRead(req.user)) {
      return res.status(403).json({ message: 'No marketing access' });
    }
    const now = new Date();
    let year = Number(req.query.year);
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
      year = now.getUTCFullYear();
    }
    const prevYear = year - 1;

    // `basis` chooses which date drives the calendar:
    //   event (default) → bookingDate (the event day)
    //   sales           → createdAt  (the day the booking was made / sold)
    const basis = String(req.query.basis || 'event').toLowerCase() === 'sales' ? 'sales' : 'event';
    const dateField = basis === 'sales' ? 'createdAt' : 'bookingDate';

    // One query spanning both calendar years: [prevYear-01-01, year+1-01-01).
    const from = new Date(Date.UTC(prevYear, 0, 1));
    const to = new Date(Date.UTC(year + 1, 0, 1));
    const bookings = await Booking.find({
      [dateField]: { $gte: from, $lt: to },
      status: { $nin: NON_REVENUE },
    })
      .select('bookingDate createdAt totalPrice')
      .lean();

    const dayStr = (d) =>
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-` +
      `${String(d.getUTCDate()).padStart(2, '0')}`;

    const current = {}; // 'YYYY-MM-DD' -> { bookings, revenue }
    const previous = {};
    const monthAgg = Array.from({ length: 12 }, () => ({
      curBookings: 0, curRevenue: 0, prevBookings: 0, prevRevenue: 0,
    }));
    let curBookings = 0, curRevenue = 0, prevBookings = 0, prevRevenue = 0;

    for (const b of bookings) {
      const d = new Date(b[dateField]);
      if (Number.isNaN(d.getTime())) continue;
      const y = d.getUTCFullYear();
      const m = d.getUTCMonth(); // 0-11
      const rev = Number(b.totalPrice) || 0;
      const target = y === year ? current : y === prevYear ? previous : null;
      if (!target) continue;
      const key = dayStr(d);
      const cur = target[key] || { bookings: 0, revenue: 0 };
      cur.bookings += 1;
      cur.revenue += rev;
      target[key] = cur;
      if (y === year) {
        curBookings++; curRevenue += rev;
        monthAgg[m].curBookings++; monthAgg[m].curRevenue += rev;
      } else {
        prevBookings++; prevRevenue += rev;
        monthAgg[m].prevBookings++; monthAgg[m].prevRevenue += rev;
      }
    }

    res.json({
      year,
      prevYear,
      basis,
      current,
      previous,
      summary: {
        current: { bookings: curBookings, revenue: curRevenue },
        previous: { bookings: prevBookings, revenue: prevRevenue },
        byMonth: monthAgg.map((v, i) => ({ month: i + 1, ...v })),
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route GET /api/marketing/re-engagement?months=6
// Past clients due for a re-touch: their last event was > N months ago and they
// have no booking since. A "who to contact now" worklist (one-tap WhatsApp on
// the client). No automated sending — the CRM has no scheduler.
export const getReEngagement = async (req, res) => {
  try {
    if (!canRead(req.user)) {
      return res.status(403).json({ message: 'No marketing access' });
    }
    const months = Math.max(1, Math.min(60, Number(req.query.months) || 6));
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);

    const bookings = await Booking.find({
      status: { $nin: NON_REVENUE },
    })
      .select('customerName phone service serviceStart bookingDate status totalPrice')
      .lean();

    // Group by phone; keep each client's most-recent event date.
    const byPhone = new Map();
    for (const b of bookings) {
      const phone = String(b.phone || '').trim();
      if (!phone) continue;
      const when = new Date(b.serviceStart || b.bookingDate);
      const cur = byPhone.get(phone);
      if (!cur || when > cur.lastEventDate) {
        byPhone.set(phone, {
          customerName: b.customerName || '',
          phone,
          service: b.service || '',
          lastEventDate: when,
          lastBookingId: b._id,
          bookings: (cur?.bookings || 0) + 1,
        });
      } else {
        cur.bookings += 1;
      }
    }

    const now = Date.now();
    const due = [...byPhone.values()]
      .filter((c) => c.lastEventDate < cutoff) // no event since the cutoff
      .map((c) => ({
        ...c,
        monthsSince: Math.floor((now - c.lastEventDate.getTime()) / (30 * 24 * 60 * 60 * 1000)),
      }))
      .sort((a, b) => a.lastEventDate - b.lastEventDate); // most overdue first

    res.json({ months, cutoff, count: due.length, clients: due.slice(0, 300) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
