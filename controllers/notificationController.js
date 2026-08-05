import Notification from '../models/Notification.js';
import Lead from '../models/Lead.js';
import Booking from '../models/Booking.js';
import Collection from '../models/Collection.js';
import Expense from '../models/Expense.js';
import {
  notify,
  getUserIdsByRoles,
  MANAGER_AND_ADMIN_ROLES,
  ADMIN_ROLES,
  ADMIN_ALLOWED_TYPES,
  NOTIFICATION_TYPES,
} from '../utils/notify.js';

// Admins (stakeholders) only ever see the month-end summary — never the
// operational stream. Restricts their inbox + unread count at read time so the
// historical backlog is hidden too, not just newly-created notifications.
const adminTypeScope = (req) =>
  ADMIN_ROLES.includes(req.user?.role)
    ? { type: { $in: [...ADMIN_ALLOWED_TYPES] } }
    : {};

// Format a stored (UTC) date as IST text for notification bodies, matching how
// the rest of the app renders times to the user.
const fmt = (d) => {
  const ist = new Date(new Date(d).getTime() + 5.5 * 60 * 60 * 1000);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let h = ist.getUTCHours();
  const m = ist.getUTCMinutes();
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${ist.getUTCDate()} ${months[ist.getUTCMonth()]}, ${h}:${String(m).padStart(2, '0')} ${ap}`;
};

// Time-based follow-up notifications (due today / missed) have no user action to
// hang off, so we generate them lazily whenever notifications are fetched. The
// sweep is global and throttled in-memory so many polling clients don't each pay
// for it, and `dedupe` guarantees the same scheduled follow-up is never
// announced twice.
let lastSweepAt = 0;
const SWEEP_INTERVAL_MS = 60 * 1000;

const sweepFollowUps = async () => {
  const nowMs = Date.now();
  if (nowMs - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = nowMs;

  try {
    const now = new Date();
    const startToday = new Date(now);
    startToday.setHours(0, 0, 0, 0);
    const endToday = new Date(now);
    endToday.setHours(23, 59, 59, 999);
    // Don't resurface follow-ups older than 30 days — keeps the inbox relevant.
    const windowStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const leads = await Lead.find({
      status: 'Follow-up',
      followUpDate: { $gte: windowStart, $lte: endToday },
    })
      .select('_id name assignedTo followUpDate')
      .limit(500);

    if (leads.length === 0) return;
    const managerAdminIds = await getUserIdsByRoles(MANAGER_AND_ADMIN_ROLES);

    for (const lead of leads) {
      const fu = lead.followUpDate;
      if (!fu) continue;
      const assigned = lead.assignedTo ? [lead.assignedTo] : [];

      if (fu < now) {
        // Missed: notify the assigned executive AND managers/admins.
        await notify({
          recipients: [...assigned, ...managerAdminIds],
          type: NOTIFICATION_TYPES.FOLLOWUP_MISSED,
          title: 'Missed follow-up',
          body: `Follow-up for ${lead.name} was missed (was due ${fmt(fu)}).`,
          leadId: lead._id,
          forDate: fu,
          dedupe: true,
        });
      } else if (fu >= startToday) {
        // Due later today: remind the assigned executive.
        await notify({
          recipients: assigned,
          type: NOTIFICATION_TYPES.FOLLOWUP_DUE,
          title: 'Follow-up due today',
          body: `You have a follow-up for ${lead.name} today at ${fmt(fu)}.`,
          leadId: lead._id,
          forDate: fu,
          dedupe: true,
        });
      }
    }
  } catch (err) {
    console.error('sweepFollowUps failed:', err.message);
  }
};

// ── Month-end summary for stakeholders (admins) ─────────────────────────────
// Admins are kept out of the operational stream (see ADMIN_ALLOWED_TYPES in
// notify.js). Instead, once a calendar month closes we post them a single
// summary of the month just ended — deduped by period so it's created exactly
// once. Generated lazily on notification fetch and throttled so many polling
// clients don't each recompute it.
let lastMonthEndCheckAt = 0;
const MONTH_END_CHECK_MS = 60 * 60 * 1000; // hourly is more than enough

const _inr = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;

const sweepMonthEndSummary = async () => {
  const nowMs = Date.now();
  if (nowMs - lastMonthEndCheckAt < MONTH_END_CHECK_MS) return;
  lastMonthEndCheckAt = nowMs;

  try {
    const admins = await getUserIdsByRoles(ADMIN_ROLES);
    if (admins.length === 0) return;

    // The calendar month that just ended.
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
    const periodKey = new Date(Date.UTC(start.getFullYear(), start.getMonth(), 1));

    // One summary per month, globally — bail if it already exists.
    const existing = await Notification.findOne({
      type: NOTIFICATION_TYPES.MONTH_END_SUMMARY,
      forDate: periodKey,
    }).select('_id');
    if (existing) return;

    const [bookings, collections, expenses] = await Promise.all([
      Booking.find({ bookingDate: { $gte: start, $lte: end } }).select('totalPrice status').lean(),
      Collection.find({ date: { $gte: start, $lte: end } }).select('amount').lean(),
      Expense.find({ date: { $gte: start, $lte: end } }).select('amount').lean(),
    ]);

    const cancelled = new Set(['cancelled', 'rejected']);
    const active = bookings.filter((b) => !cancelled.has(String(b.status || '').toLowerCase()));
    const revenue = active.reduce((s, b) => s + (b.totalPrice || 0), 0);
    const collected = collections.reduce((s, c) => s + (c.amount || 0), 0);
    const spent = expenses.reduce((s, e) => s + (e.amount || 0), 0);

    const months = ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'];
    const label = `${months[start.getMonth()]} ${start.getFullYear()}`;

    await notify({
      recipients: admins,
      type: NOTIFICATION_TYPES.MONTH_END_SUMMARY,
      title: `${label} month-end summary`,
      body: `Sales ${_inr(revenue)} across ${active.length} works · Collected ${_inr(collected)} · Expenses ${_inr(spent)}.`,
      link: '/reports/analyst',
      forDate: periodKey,
    });
  } catch (err) {
    console.error('sweepMonthEndSummary failed:', err.message);
  }
};

export const getNotifications = async (req, res) => {
  try {
    await sweepFollowUps();
    await sweepMonthEndSummary();

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 30;
    const skip = (page - 1) * limit;

    const scope = adminTypeScope(req);
    const filter = { recipient: req.user._id, ...scope };
    if (req.query.unread === 'true') filter.read = false;

    const [items, totalItems, unreadCount] = await Promise.all([
      Notification.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('leadId', 'name')
        .populate('createdBy', 'name'),
      Notification.countDocuments(filter),
      Notification.countDocuments({ recipient: req.user._id, read: false, ...scope }),
    ]);

    res.json({
      items,
      totalItems,
      totalPages: Math.ceil(totalItems / limit),
      page,
      limit,
      unreadCount,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getUnreadCount = async (req, res) => {
  try {
    const count = await Notification.countDocuments({
      recipient: req.user._id,
      read: false,
      ...adminTypeScope(req),
    });
    res.json({ count });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const markRead = async (req, res) => {
  try {
    const n = await Notification.findOneAndUpdate(
      { _id: req.params.id, recipient: req.user._id },
      { read: true, readAt: new Date() },
      { new: true }
    );
    if (!n) return res.status(404).json({ message: 'Notification not found' });
    res.json(n);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const markAllRead = async (req, res) => {
  try {
    const result = await Notification.updateMany(
      { recipient: req.user._id, read: false },
      { read: true, readAt: new Date() }
    );
    res.json({
      message: 'All notifications marked as read',
      modifiedCount: result.modifiedCount,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
