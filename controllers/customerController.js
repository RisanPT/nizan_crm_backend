import Customer from '../models/Customer.js';
import Booking from '../models/Booking.js';

const _last10 = (v) => String(v ?? '').replace(/\D/g, '').slice(-10);

// The calendar renders an event on its IST (local) day; the report must show the
// SAME day. Bookings are stored in UTC, so a 5:00 AM IST event lives on the
// previous UTC day — reading the raw UTC date would show the report one day off.
// Convert to IST, then emit a date-only string so the day is unambiguous.
const _IST_MS = 5.5 * 60 * 60 * 1000;
const _istDateOnly = (d) => {
  const t = new Date(new Date(d).getTime() + _IST_MS);
  const y = t.getUTCFullYear();
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const day = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

// Candidate event dates for a booking, matching the calendar's basis: the
// selected event dates when present, else serviceStart, else bookingDate.
const _bookingEventDates = (b) => {
  const sd = Array.isArray(b.selectedDates) ? b.selectedDates.filter(Boolean) : [];
  if (sd.length) return sd.map((d) => new Date(d));
  const fallback = b.serviceStart || b.bookingDate;
  return fallback ? [new Date(fallback)] : [];
};

// The client's event date should reflect their actual booking, not the (often
// empty) manually-stored Customer.eventDate. For each customer we match bookings
// by phone and prefer the next UPCOMING event; fall back to a stored date, then
// to the most recent past event. Mutates + returns the lean customer array.
// `allBookings: true` is for whole-directory passes (event sort/filter, stats):
// one scan of every active booking is far cheaper than a regex per phone.
const attachBookingEventDates = async (customers, { allBookings = false } = {}) => {
  const phones = [
    ...new Set(customers.map((c) => _last10(c.phone)).filter((p) => p.length === 10)),
  ];
  if (phones.length === 0) return customers;

  const active = { status: { $nin: ['cancelled', 'rejected', 'Cancelled', 'Rejected'] } };
  const bookings = await Booking.find(
    allBookings
      ? active
      : { ...active, phone: { $in: phones.map((p) => new RegExp(`${p}$`)) } }
  )
    .select('phone bookingDate serviceStart selectedDates')
    .lean();

  const byPhone = new Map();
  for (const b of bookings) {
    const k = _last10(b.phone);
    if (!k) continue;
    const arr = byPhone.get(k) || [];
    for (const d of _bookingEventDates(b)) arr.push(d);
    byPhone.set(k, arr);
  }

  const now = new Date();
  for (const c of customers) {
    const dates = (byPhone.get(_last10(c.phone)) || []).filter((d) => !isNaN(d));
    if (dates.length === 0) continue;
    const upcoming = dates.filter((d) => d >= now).sort((a, b) => a - b);
    if (upcoming.length) {
      c.eventDate = _istDateOnly(upcoming[0]);
    } else if (!c.eventDate) {
      c.eventDate = _istDateOnly(dates.sort((a, b) => b - a)[0]);
    }
  }
  return customers;
};

const SORT_MAP = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  name_asc: { name: 1 },
  name_desc: { name: -1 },
};

// Sorts that depend on the booking-derived event date, which isn't stored on
// the customer — these are sorted in memory after attaching event dates.
const EVENT_SORTS = new Set(['event_soonest', 'event_latest']);
const EVENT_FILTERS = new Set(['upcoming', 'past', 'none', 'range']);
const STATUSES = ['Active', 'Inactive', 'Prospect'];

const _todayIst = () => _istDateOnly(new Date());

// 'YYYY-MM-DD' (or any Date-parsable string) → Date, else null.
const _parseDay = (v) => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

// Event-date filter on already-attached `eventDate` strings (YYYY-MM-DD).
const _matchesEventFilter = (c, filter, from, to) => {
  const ev = String(c.eventDate ?? '').slice(0, 10);
  const today = _todayIst();
  switch (filter) {
    case 'upcoming':
      return !!ev && ev >= today;
    case 'past':
      return !!ev && ev < today;
    case 'none':
      return !ev;
    case 'range':
      if (!ev) return false;
      if (from && ev < from) return false;
      if (to && ev > to) return false;
      return true;
    default:
      return true;
  }
};

// Mongo query from the list params shared by the list and its status counts.
const _baseQuery = (q, { withStatus = true } = {}) => {
  const query = {};
  const search = String(q.search ?? '').trim();
  if (search) {
    const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    query.$or = [{ name: rx }, { phone: rx }, { email: rx }, { company: rx }];
  }
  const status = String(q.status ?? '').trim();
  if (withStatus && status && status !== 'All') query.status = status;

  // Date the client was added (createdAt), inclusive whole days.
  const addedFrom = _parseDay(q.addedFrom);
  const addedTo = _parseDay(q.addedTo);
  if (addedFrom || addedTo) {
    query.createdAt = {};
    if (addedFrom) query.createdAt.$gte = addedFrom;
    if (addedTo) {
      const end = new Date(addedTo);
      end.setUTCHours(23, 59, 59, 999);
      query.createdAt.$lte = end;
    }
  }
  return query;
};

// Per-status counts for the filter chips (search/date filters applied, status
// not — so every chip shows how many it would return).
const _statusCounts = async (q) => {
  const rows = await Customer.aggregate([
    { $match: _baseQuery(q, { withStatus: false }) },
    { $group: { _id: '$status', n: { $sum: 1 } } },
  ]);
  const counts = { All: 0, Active: 0, Inactive: 0, Prospect: 0 };
  for (const r of rows) {
    if (STATUSES.includes(r._id)) counts[r._id] = r.n;
    counts.All += r.n;
  }
  return counts;
};

export const getCustomers = async (req, res) => {
  try {
    const page = Number.parseInt(req.query.page, 10);
    const limit = Number.parseInt(req.query.limit, 10);

    // Search across name / phone / email / company, filter by status and date
    // added, and sort.
    const query = _baseQuery(req.query);
    const sortKey = String(req.query.sort ?? 'newest');
    const sort = SORT_MAP[sortKey] || SORT_MAP.newest;
    const eventFilter = String(req.query.event ?? '').trim();
    const needsEventPass =
      EVENT_SORTS.has(sortKey) || EVENT_FILTERS.has(eventFilter);

    // Event date comes from bookings, so event filters/sorts are applied in
    // memory over the whole matching set, then paginated.
    if (needsEventPass) {
      // Fetch without the status filter so the chip counts reflect the event
      // filter too; status is applied afterwards.
      const all = await Customer.find(_baseQuery(req.query, { withStatus: false }))
        .sort(sort)
        .lean();
      await attachBookingEventDates(all, { allBookings: true });

      const from = String(req.query.eventFrom ?? '').slice(0, 10);
      const to = String(req.query.eventTo ?? '').slice(0, 10);
      const eventRows = EVENT_FILTERS.has(eventFilter)
        ? all.filter((c) => _matchesEventFilter(c, eventFilter, from, to))
        : all;
      const counts = { All: eventRows.length, Active: 0, Inactive: 0, Prospect: 0 };
      for (const c of eventRows) if (STATUSES.includes(c.status)) counts[c.status] += 1;
      let rows = query.status
        ? eventRows.filter((c) => c.status === query.status)
        : eventRows;

      if (EVENT_SORTS.has(sortKey)) {
        const today = _todayIst();
        const key = (c) => String(c.eventDate ?? '').slice(0, 10);
        rows = [...rows].sort((a, b) => {
          const ea = key(a);
          const eb = key(b);
          if (!ea && !eb) return 0;
          if (!ea) return 1; // no event → always last
          if (!eb) return -1;
          if (sortKey === 'event_latest') return eb.localeCompare(ea);
          // Soonest: upcoming events ascending first, then past most-recent first.
          const ua = ea >= today;
          const ub = eb >= today;
          if (ua !== ub) return ua ? -1 : 1;
          return ua ? ea.localeCompare(eb) : eb.localeCompare(ea);
        });
      }

      const currentLimit = Math.min(100, Math.max(1, limit || 20));
      const currentPage = Math.max(1, page || 1);
      const start = (currentPage - 1) * currentLimit;
      if (!Number.isFinite(page) && !Number.isFinite(limit)) {
        return res.json(rows);
      }
      return res.json({
        items: rows.slice(start, start + currentLimit),
        page: currentPage,
        limit: currentLimit,
        totalItems: rows.length,
        totalPages: Math.max(1, Math.ceil(rows.length / currentLimit)),
        counts,
      });
    }

    if (Number.isFinite(page) || Number.isFinite(limit)) {
      const currentPage = Math.max(1, page || 1);
      const currentLimit = Math.min(100, Math.max(1, limit || 20));
      const skip = (currentPage - 1) * currentLimit;

      const [items, totalItems, counts] = await Promise.all([
        Customer.find(query)
          .sort(sort)
          .skip(skip)
          .limit(currentLimit)
          .lean(),
        Customer.countDocuments(query),
        _statusCounts(req.query),
      ]);
      await attachBookingEventDates(items);

      return res.json({
        items,
        page: currentPage,
        limit: currentLimit,
        totalItems,
        totalPages: Math.max(1, Math.ceil(totalItems / currentLimit)),
        counts,
      });
    }

    const customers = await Customer.find(query).sort(sort).lean();
    await attachBookingEventDates(customers);
    res.json(customers);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Directory summary cards: totals by status, upcoming events and new clients.
export const getCustomerStats = async (req, res) => {
  try {
    const customers = await Customer.find({})
      .select('phone status createdAt eventDate')
      .lean();
    await attachBookingEventDates(customers, { allBookings: true });

    const today = _todayIst();
    const in30 = _istDateOnly(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const stats = {
      total: customers.length,
      active: 0,
      inactive: 0,
      prospect: 0,
      upcomingEvents: 0, // event today or later
      eventsNext30Days: 0,
      addedThisMonth: 0,
    };
    for (const c of customers) {
      if (c.status === 'Active') stats.active += 1;
      else if (c.status === 'Inactive') stats.inactive += 1;
      else stats.prospect += 1;
      const ev = String(c.eventDate ?? '').slice(0, 10);
      if (ev && ev >= today) {
        stats.upcomingEvents += 1;
        if (ev <= in30) stats.eventsNext30Days += 1;
      }
      if (c.createdAt && new Date(c.createdAt) >= monthStart) stats.addedThisMonth += 1;
    }
    res.json(stats);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const createCustomer = async (req, res) => {
  const { name, email, phone, address, pincode, company, eventDate, status } = req.body;

  try {
    // Match by email OR phone to avoid duplicates
    const query = [];
    if (email) query.push({ email });
    if (phone) query.push({ phone });

    const customerExists = query.length > 0
      ? await Customer.findOne({ $or: query })
      : null;

    if (customerExists) {
      return res.status(400).json({ message: 'Customer already exists' });
    }

    const customer = await Customer.create({
      name,
      email: email || `${phone}@placeholder.local`,
      phone,
      address,
      pincode,
      company,
      eventDate,
      status,
    });

    res.status(201).json(customer);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateCustomer = async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id);

    if (!customer) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    const { name, email, phone, address, pincode, company, eventDate, status } = req.body;

    customer.name = name ?? customer.name;
    customer.email = email ?? customer.email;
    customer.phone = phone ?? customer.phone;
    customer.address = address ?? customer.address;
    customer.pincode = pincode ?? customer.pincode;
    customer.company = company ?? customer.company;
    customer.eventDate = eventDate ?? customer.eventDate;
    customer.status = status ?? customer.status;

    const updated = await customer.save();
    res.json(updated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteCustomer = async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id);

    if (!customer) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    await customer.deleteOne();
    res.json({ message: 'Customer removed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
