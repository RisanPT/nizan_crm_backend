import ClientUser from '../models/ClientUser.js';
import Booking from '../models/Booking.js';
import Conversation from '../models/Conversation.js';
import { phoneSuffixFilter } from '../utils/phone.js';
import { canSeeClientChat } from './chatController.js';

// Same client-facing staff who can use the concierge chat may view app clients.
export const canSeeAppClients = canSeeClientChat;

const listView = (c) => ({
  _id: String(c._id),
  name: c.name || '',
  phone: c.phone || '',
  email: c.email || '',
  status: c.status || 'active',
  lastLoginAt: c.lastLoginAt,
  createdAt: c.createdAt,
  savedLookCount: (c.savedLooks || []).length,
  hasPreferences: !!(c.preferences && Object.keys(c.preferences).length),
});

const bookingView = (b) => ({
  _id: String(b._id),
  bookingNumber: b.bookingNumber || '',
  status: b.status || 'pending',
  service: b.service || (b.bookingItems || []).map((i) => i.service).join(', '),
  bookingDate: b.bookingDate,
  selectedDates: b.selectedDates || [],
  totalPrice: b.totalPrice || 0,
  collectedAmount: b.collectedAmount || 0,
  balanceDue: Math.max(0, (b.totalPrice || 0) - (b.collectedAmount || 0)),
  isTrial: /trial/i.test(b.service || ''),
  culture: b.culture || '',
  // The look-plan brief the bride attached when requesting a trial.
  brief: b.staffInstructions || '',
  createdAt: b.createdAt,
});

// @route GET /api/app-clients?search=
export const listAppClients = async (req, res) => {
  try {
    const q = String(req.query.search || '').trim();
    const filter = {};
    if (q) {
      filter.$or = [
        { name: { $regex: q, $options: 'i' } },
        { email: { $regex: q, $options: 'i' } },
        { phone: { $regex: q.replace(/\D/g, '') } },
      ];
    }
    const rows = await ClientUser.find(filter)
      .sort({ lastLoginAt: -1, createdAt: -1 })
      .limit(300)
      .lean();
    res.json(rows.map(listView));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route GET /api/app-clients/:id
export const getAppClient = async (req, res) => {
  try {
    const c = await ClientUser.findById(req.params.id).lean();
    if (!c) {
      res.status(404);
      return res.json({ message: 'Client not found' });
    }
    const filters = [phoneSuffixFilter(c.phone)];
    if (c.email) filters.push({ email: c.email });
    const bookings = await Booking.find({ $or: filters })
      .sort({ bookingDate: -1 })
      .limit(50)
      .lean();
    const convo = await Conversation.findOne({ clientUserId: c._id })
      .select('_id')
      .lean();
    res.json({
      client: {
        ...listView(c),
        communityTag: c.communityTag || '',
        preferences: c.preferences || {},
        savedLooks: c.savedLooks || [],
        lookPlan: c.lookPlan || [],
      },
      bookings: bookings.map(bookingView),
      conversationId: convo ? String(convo._id) : null,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
