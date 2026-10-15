import Booking from '../models/Booking.js';
import { normalizePhone, phoneSuffixFilter } from '../utils/phone.js';

// Fields safe to expose to the client app for their own bookings.
const bookingView = (b) => ({
  _id: String(b._id),
  bookingNumber: b.bookingNumber || '',
  status: b.status || 'pending',
  customerName: b.customerName || '',
  phone: b.phone || '',
  email: b.email || '',
  address: b.address || '',
  bookingDate: b.bookingDate,
  selectedDates: b.selectedDates || [],
  serviceStart: b.serviceStart,
  serviceEnd: b.serviceEnd,
  totalPrice: b.totalPrice || 0,
  advanceAmount: b.advanceAmount || 0,
  collectedAmount: b.collectedAmount || 0,
  balanceDue: Math.max(0, (b.totalPrice || 0) - (b.collectedAmount || 0)),
  bookingItems: (b.bookingItems || []).map((it) => ({
    service: it.service || '',
    eventSlot: it.eventSlot || '',
    selectedDates: it.selectedDates || [],
    totalPrice: it.totalPrice || 0,
  })),
  looks: b.looks || [],
  createdAt: b.createdAt,
});

const ownsBooking = (booking, client) => {
  const last10 = normalizePhone(client.phone);
  const bPhone = normalizePhone(booking.phone);
  if (last10 && bPhone && bPhone === last10) return true;
  if (client.email && booking.email && String(booking.email).toLowerCase() === client.email) return true;
  return false;
};

// @route GET /api/client/me
export const getMe = async (req, res) => {
  const c = req.client;
  res.json({
    id: String(c._id),
    name: c.name || '',
    phone: c.phone || '',
    email: c.email || '',
    communityTag: c.communityTag || '',
    skinTone: c.skinTone || '',
  });
};

// @route PUT /api/client/me  { name?, email?, communityTag?, skinTone? }
export const updateMe = async (req, res) => {
  try {
    const c = req.client;
    if (req.body.name !== undefined) c.name = String(req.body.name).trim();
    if (req.body.email !== undefined) c.email = String(req.body.email).trim().toLowerCase();
    if (req.body.communityTag !== undefined) c.communityTag = String(req.body.communityTag).trim();
    if (req.body.skinTone !== undefined) c.skinTone = String(req.body.skinTone).trim();
    await c.save();
    res.json({ id: String(c._id), name: c.name, phone: c.phone, email: c.email });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route GET /api/client/bookings — the signed-in client's own bookings
export const getMyBookings = async (req, res) => {
  try {
    const filters = [phoneSuffixFilter(req.client.phone)];
    if (req.client.email) filters.push({ email: req.client.email });
    const bookings = await Booking.find({ $or: filters }).sort({ bookingDate: -1 }).limit(100).lean();
    res.json(bookings.map(bookingView));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route GET /api/client/bookings/:id
export const getMyBooking = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id).lean();
    if (!booking || !ownsBooking(booking, req.client)) {
      return res.status(404).json({ message: 'Booking not found' });
    }
    res.json(bookingView(booking));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Middleware: force the booking request to the authenticated client's identity,
// then hand off to the shared public createBooking (which runs its public
// branch because protectClient sets req.client, not req.user).
export const forceClientIdentity = (req, res, next) => {
  req.body = req.body || {};
  req.body.phone = req.client.phone;
  if (!req.body.customerName && req.client.name) req.body.customerName = req.client.name;
  if (!req.body.email && req.client.email) req.body.email = req.client.email;
  next();
};

// ─── Preferences (survey answers) ────────────────────────────────────────────
// @route GET /api/client/preferences
export const getPreferences = (req, res) => {
  res.json({ preferences: req.client.preferences || {} });
};

// @route PUT /api/client/preferences  { preferences: { qid: [..] } }
export const savePreferences = async (req, res) => {
  try {
    const prefs = req.body.preferences;
    req.client.preferences =
      prefs && typeof prefs === 'object' && !Array.isArray(prefs) ? prefs : {};
    req.client.markModified('preferences');
    await req.client.save();
    res.json({ preferences: req.client.preferences });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─── Look Board ──────────────────────────────────────────────────────────────
// @route GET /api/client/lookboard
export const getLookBoard = (req, res) => {
  res.json({ looks: req.client.savedLooks || [] });
};

// @route PUT /api/client/lookboard  { looks: [{id, look, culture}] }  (replace)
export const saveLookBoard = async (req, res) => {
  try {
    const looks = (Array.isArray(req.body.looks) ? req.body.looks : [])
      .map((l) => ({
        id: String(l?.id ?? '').trim(),
        look: String(l?.look ?? '').trim(),
        culture: String(l?.culture ?? '').trim(),
      }))
      .filter((l) => l.id);
    req.client.savedLooks = looks;
    await req.client.save();
    res.json({ looks: req.client.savedLooks });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─── Look Plan ───────────────────────────────────────────────────────────────
// The bride's chosen outfit / jewellery / hair / makeup per function.
const short = (v, n = 120) => String(v ?? '').trim().slice(0, n);

// Defensive: this is client-supplied, so cap sizes and drop empties.
const sanitizeLookPlan = (raw) =>
  (Array.isArray(raw) ? raw : [])
    .slice(0, 40)
    .map((e) => ({
      tradition: short(e?.tradition, 60),
      traditionName: short(e?.traditionName, 80),
      function: short(e?.function, 60),
      picks: (Array.isArray(e?.picks) ? e.picks : [])
        .slice(0, 6)
        .map((p) => ({
          category: short(p?.category, 30),
          optionId: short(p?.optionId, 60),
          name: short(p?.name, 120),
        }))
        .filter((p) => p.category && p.optionId),
    }))
    .filter((e) => e.tradition && e.function && e.picks.length > 0);

// @route GET /api/client/lookplan
export const getLookPlan = (req, res) => {
  res.json({ lookPlan: req.client.lookPlan || [] });
};

// @route PUT /api/client/lookplan  { lookPlan: [{tradition, traditionName, function, picks:[{category, optionId, name}]}] }  (replace)
export const saveLookPlan = async (req, res) => {
  try {
    req.client.lookPlan = sanitizeLookPlan(req.body.lookPlan);
    await req.client.save();
    res.json({ lookPlan: req.client.lookPlan });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
