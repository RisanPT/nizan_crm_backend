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
        'region district culture bookingDate totalPrice service eventSlot ' +
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
    const byRegionM = new Map(), byDistrictM = new Map(),
      byMonthM = new Map(), byCultureM = new Map();
    for (const b of segBookings) {
      bump(byRegionM, b.region, b.totalPrice);
      bump(byDistrictM, b.district, b.totalPrice);
      bump(byMonthM, monthKey(b.bookingDate), b.totalPrice);
      // Explicit field wins; otherwise infer from what was booked; else blank.
      const culture =
        (b.culture || '').trim() || inferCulture(b) || 'Not specified';
      bump(byCultureM, culture, b.totalPrice);
    }
    const topList = (m, n = 12) =>
      [...m.values()].sort((a, b) => b.bookings - a.bookings).slice(0, n);
    const segments = {
      byRegion: topList(byRegionM),
      byDistrict: topList(byDistrictM),
      byMonth: [...byMonthM.values()].sort((a, b) => a.name.localeCompare(b.name)),
      byCulture: [...byCultureM.values()].sort((a, b) => b.bookings - a.bookings),
      totalBookings: segBookings.length,
    };

    res.json({
      range: { from, to, fyLabel },
      nps: { ...npsOf(npsVals), trend: npsTrend },
      csat,
      artistUtilization,
      slotUtilization,
      segments,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
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
