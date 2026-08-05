import Notification from '../models/Notification.js';
import User from '../models/User.js';

// Role groups used by the notification matrix. `role` on User holds a Role.key,
// so these are the keys management/admin accounts use. Keep the manager set in
// sync with LOST_REVIEWER_ROLES in leadController.js.
export const ADMIN_ROLES = ['admin'];
export const MANAGER_ROLES = ['manager', 'sales_manager', 'regional_manager'];
export const MANAGER_AND_ADMIN_ROLES = [...MANAGER_ROLES, ...ADMIN_ROLES];

// Canonical event keys (mirrored by the Flutter notification model).
export const NOTIFICATION_TYPES = {
  NEW_LEAD: 'new_lead',
  FOLLOWUP_ASSIGNED: 'followup_assigned',
  FOLLOWUP_DUE: 'followup_due',
  FOLLOWUP_MISSED: 'followup_missed',
  FOLLOWUP_COMPLETED: 'followup_completed',
  LOST_REQUESTED: 'lost_requested',
  LOST_RESULT: 'lost_result',
  BOOKING_CREATED: 'booking_created',
  MONTH_END_SUMMARY: 'month_end_summary',
};

// Stakeholders (admin accounts) are not part of the day-to-day operational
// notification stream — they only want the month-end summary. Any notification
// whose type is NOT in this set is never delivered to an admin, no matter which
// roles a controller passes to notify()/notifyRoles().
export const ADMIN_ALLOWED_TYPES = new Set([NOTIFICATION_TYPES.MONTH_END_SUMMARY]);

const idStr = (v) => (v == null ? '' : String(v._id ?? v));

/// Resolve the active user ids that hold any of [roles].
export const getUserIdsByRoles = async (roles) => {
  if (!roles || roles.length === 0) return [];
  const users = await User.find({
    role: { $in: roles },
    active: { $ne: false },
  }).select('_id');
  return users.map((u) => u._id);
};

/// Resolve the login-user ids linked to the given Employee ids (staff/driver/
/// artist accounts carry `employeeId`). Lets us notify "the assigned driver"
/// when the domain object references an employee rather than a user.
export const getUserIdsByEmployeeIds = async (employeeIds) => {
  const ids = (employeeIds || []).filter(Boolean);
  if (ids.length === 0) return [];
  const users = await User.find({
    employeeId: { $in: ids },
    active: { $ne: false },
  }).select('_id');
  return users.map((u) => u._id);
};

/**
 * Fan-out create one Notification per recipient. Never throws — a notification
 * failure must not break the business action that triggered it.
 *
 * @param {Object} opts
 * @param {Array}  opts.recipients   User ids (or docs) to notify.
 * @param {string} opts.type         One of NOTIFICATION_TYPES.
 * @param {string} opts.title
 * @param {string} opts.body
 * @param {*}      [opts.leadId]
 * @param {*}      [opts.bookingId]
 * @param {string} [opts.link]       In-app route the notification points at.
 * @param {Date}   [opts.forDate]    Dedup key for time-based follow-up events.
 * @param {*}      [opts.createdBy]  Actor who triggered the event.
 * @param {*}      [opts.excludeUserId] Recipient to drop (usually the actor).
 * @param {boolean}[opts.dedupe]     Skip if an identical (recipient,type,lead,forDate) exists.
 */
export const notify = async ({
  recipients = [],
  type,
  title = '',
  body = '',
  leadId = null,
  bookingId = null,
  link = '',
  forDate = null,
  createdBy = null,
  excludeUserId = null,
  dedupe = false,
} = {}) => {
  try {
    const exclude = idStr(excludeUserId);
    // Unique, non-empty recipient ids, minus the excluded actor.
    let ids = [...new Set(recipients.map(idStr).filter(Boolean))].filter(
      (id) => id !== exclude
    );
    if (ids.length === 0) return;

    // Suppress operational notifications for stakeholders (admins) — they only
    // receive the month-end summary. Applied centrally so every controller and
    // every role fan-out (notifyRoles, MANAGER_AND_ADMIN_ROLES, etc.) obeys it.
    if (!ADMIN_ALLOWED_TYPES.has(type)) {
      const admins = await User.find({
        _id: { $in: ids },
        role: { $in: ADMIN_ROLES },
      }).select('_id');
      if (admins.length) {
        const adminSet = new Set(admins.map((u) => String(u._id)));
        ids = ids.filter((id) => !adminSet.has(id));
      }
      if (ids.length === 0) return;
    }

    let targets = ids;
    if (dedupe) {
      const existing = await Notification.find({
        recipient: { $in: ids },
        type,
        leadId,
        forDate,
      }).select('recipient');
      const seen = new Set(existing.map((e) => String(e.recipient)));
      targets = ids.filter((id) => !seen.has(id));
    }
    if (targets.length === 0) return;

    const docs = targets.map((recipient) => ({
      recipient,
      type,
      title,
      body,
      leadId,
      bookingId,
      link,
      forDate,
      createdBy,
    }));
    await Notification.insertMany(docs, { ordered: false });
  } catch (err) {
    // Swallow — notifications are best-effort.
    console.error('notify() failed:', err.message);
  }
};

/// Convenience: notify everyone holding any of [roles].
export const notifyRoles = async ({ roles, ...rest }) => {
  const ids = await getUserIdsByRoles(roles);
  await notify({ ...rest, recipients: ids });
};
