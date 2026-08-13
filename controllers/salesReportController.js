import Booking from '../models/Booking.js';
import Collection from '../models/Collection.js';
import Lead from '../models/Lead.js';
import User from '../models/User.js';

const FINANCE_ROLES = ['admin', 'manager', 'accounts'];
const canManageFinance = (user) => FINANCE_ROLES.includes(user?.role);

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// A "sale" excludes the same non-revenue statuses as GST / P&L so these reports
// reconcile with the books.
const SALES_EXCLUDED = ['cancelled', 'canceled', 'rejected', 'lost', 'draft', 'pending'];
const isSale = (b) => !SALES_EXCLUDED.includes(String(b.status || '').toLowerCase());

const dateFilter = (field, from, to) => {
  const q = {};
  if (from || to) {
    q[field] = {};
    if (from) q[field].$gte = new Date(from);
    if (to) q[field].$lte = new Date(to);
  }
  return q;
};

// All revenue bookings in the window.
const saleBookings = async (from, to) => {
  const bookings = await Booking.find(dateFilter('bookingDate', from, to))
    .select('customerName phone service totalPrice collectedAmount bookingDate status leadId')
    .limit(50000)
    .lean();
  return bookings.filter(isSale);
};

// Roll a Map of rows into the uniform { rows, totals } payload (sorted by amount
// desc unless the caller pre-sorts).
const pack = (map, { sort = 'amount' } = {}) => {
  let rows = [...map.values()];
  if (sort === 'amount') rows.sort((a, b) => b.amount - a.amount);
  else if (sort === 'label') rows.sort((a, b) => String(a.label).localeCompare(String(b.label)));
  const totals = { count: 0, amount: 0, received: 0 };
  for (const r of rows) {
    totals.count += r.count;
    totals.amount += r.amount;
    totals.received += r.received;
    r.amount = round2(r.amount);
    r.received = round2(r.received);
    if (r.outstanding !== undefined) r.outstanding = round2(r.outstanding);
  }
  return {
    rows,
    totals: { count: totals.count, amount: round2(totals.amount), received: round2(totals.received) },
  };
};

const guard = (req, res) => {
  if (!canManageFinance(req.user)) {
    res.status(403).json({ message: 'No finance access' });
    return false;
  }
  return true;
};

// @desc    Sales grouped by customer.
// @route   GET /api/sales-reports/by-customer?from&to
export const salesByCustomer = async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const { from, to } = req.query;
    const bookings = await saleBookings(from, to);
    const map = new Map();
    for (const b of bookings) {
      const key = `${b.customerName || 'Unknown'}|${b.phone || ''}`;
      if (!map.has(key)) {
        map.set(key, { label: b.customerName || 'Unknown', sublabel: b.phone || '', count: 0, amount: 0, received: 0, outstanding: 0 });
      }
      const r = map.get(key);
      r.count += 1;
      r.amount += b.totalPrice || 0;
      r.received += b.collectedAmount || 0;
      r.outstanding += (b.totalPrice || 0) - (b.collectedAmount || 0);
    }
    res.json(pack(map));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Sales grouped by package / service.
// @route   GET /api/sales-reports/by-package?from&to
export const salesByPackage = async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const { from, to } = req.query;
    const bookings = await saleBookings(from, to);
    const map = new Map();
    for (const b of bookings) {
      const key = (b.service && b.service.trim()) || 'Unspecified';
      if (!map.has(key)) map.set(key, { label: key, sublabel: '', count: 0, amount: 0, received: 0 });
      const r = map.get(key);
      r.count += 1;
      r.amount += b.totalPrice || 0;
      r.received += b.collectedAmount || 0;
    }
    res.json(pack(map));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Sales grouped by salesperson (via the lead the booking converted).
// @route   GET /api/sales-reports/by-salesperson?from&to
export const salesBySalesperson = async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const { from, to } = req.query;
    const bookings = await saleBookings(from, to);

    const leadIds = [...new Set(bookings.filter((b) => b.leadId).map((b) => String(b.leadId)))];
    const leads = await Lead.find({ _id: { $in: leadIds } }).select('assignedTo').lean();
    const leadToUser = new Map(leads.map((l) => [String(l._id), l.assignedTo ? String(l.assignedTo) : null]));
    const userIds = [...new Set([...leadToUser.values()].filter(Boolean))];
    const users = await User.find({ _id: { $in: userIds } }).select('name').lean();
    const userName = new Map(users.map((u) => [String(u._id), u.name || 'Unknown']));

    const map = new Map();
    for (const b of bookings) {
      const uid = b.leadId ? leadToUser.get(String(b.leadId)) : null;
      const name = uid ? userName.get(uid) || 'Unknown' : 'Direct / Unassigned';
      if (!map.has(name)) map.set(name, { label: name, sublabel: '', count: 0, amount: 0, received: 0 });
      const r = map.get(name);
      r.count += 1;
      r.amount += b.totalPrice || 0;
      r.received += b.collectedAmount || 0;
    }
    res.json(pack(map));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Sales summary by day or month.
// @route   GET /api/sales-reports/summary?from&to&groupBy=day|month
export const salesSummary = async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const { from, to } = req.query;
    const groupBy = req.query.groupBy === 'month' ? 'month' : 'day';
    const bookings = await saleBookings(from, to);
    const map = new Map();
    for (const b of bookings) {
      const d = new Date(b.bookingDate || Date.now());
      const key =
        groupBy === 'month'
          ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
          : d.toISOString().slice(0, 10);
      if (!map.has(key)) map.set(key, { label: key, sublabel: '', count: 0, amount: 0, received: 0 });
      const r = map.get(key);
      r.count += 1;
      r.amount += b.totalPrice || 0;
      r.received += b.collectedAmount || 0;
    }
    res.json({ ...pack(map, { sort: 'label' }), groupBy });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const MODE_LABEL = { cash: 'Cash', upi: 'UPI', bank_transfer: 'Bank Transfer', other: 'Other' };

// @desc    Payments received grouped by mode (cash / bank / UPI …).
// @route   GET /api/sales-reports/by-payment-mode?from&to
export const paymentsByMode = async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const { from, to } = req.query;
    const collections = await Collection.find({
      ...dateFilter('date', from, to),
      status: { $ne: 'rejected' },
    })
      .select('paymentMode amount')
      .limit(100000)
      .lean();
    const map = new Map();
    for (const c of collections) {
      const key = c.paymentMode || 'other';
      if (!map.has(key)) map.set(key, { label: MODE_LABEL[key] || key, sublabel: '', count: 0, amount: 0, received: 0 });
      const r = map.get(key);
      r.count += 1;
      r.amount += c.amount || 0;
    }
    res.json(pack(map));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
