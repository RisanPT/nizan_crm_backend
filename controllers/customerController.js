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
const attachBookingEventDates = async (customers) => {
  const phones = [
    ...new Set(customers.map((c) => _last10(c.phone)).filter((p) => p.length === 10)),
  ];
  if (phones.length === 0) return customers;

  const rx = phones.map((p) => new RegExp(`${p}$`));
  const bookings = await Booking.find({
    phone: { $in: rx },
    status: { $nin: ['cancelled', 'rejected', 'Cancelled', 'Rejected'] },
  })
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

export const getCustomers = async (req, res) => {
  try {
    const page = Number.parseInt(req.query.page, 10);
    const limit = Number.parseInt(req.query.limit, 10);

    if (Number.isFinite(page) || Number.isFinite(limit)) {
      const currentPage = Math.max(1, page || 1);
      const currentLimit = Math.min(100, Math.max(1, limit || 20));
      const skip = (currentPage - 1) * currentLimit;

      const [items, totalItems] = await Promise.all([
        Customer.find({})
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(currentLimit)
          .lean(),
        Customer.countDocuments({}),
      ]);
      await attachBookingEventDates(items);

      return res.json({
        items,
        page: currentPage,
        limit: currentLimit,
        totalItems,
        totalPages: Math.max(1, Math.ceil(totalItems / currentLimit)),
      });
    }

    const customers = await Customer.find({}).sort({ createdAt: -1 }).lean();
    await attachBookingEventDates(customers);
    res.json(customers);
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
