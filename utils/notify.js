import Notification from '../models/Notification.js';
import User from '../models/User.js';
import Role from '../models/Role.js';

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
  REPORT_UPLOADED: 'report_uploaded',
  REVIEW_SUBMITTED: 'review_submitted',
  CLIENT_MESSAGE: 'client_message',
  MONTH_END_SUMMARY: 'month_end_summary',
  // The CEO's once-a-day line: what needs their decision and what is stuck with the team.
  CEO_DIGEST: 'ceo_digest',
  // Monthly objectives: a department head is asked to set this month's, and to close out last month's.
  MONTHLY_OBJECTIVES_SET: 'monthly_objectives_set',
  MONTHLY_OBJECTIVES_CLOSE: 'monthly_objectives_close',
  // Every key result of an objective is done: the head may close it as achieved.
  MONTHLY_OBJECTIVE_READY: 'monthly_objective_ready',
  SALES_TARGET_MIDMONTH: 'sales_target_midmonth',
  SALES_TARGET_TEAM_MIDMONTH: 'sales_target_team_midmonth',
  // Company Projects: a department invited to a project / its answer, a staff
  // proposal waiting for approval / the decision.
  PROJECT_INVITE: 'project_invite',
  PROJECT_RESPONSE: 'project_response',
  PROJECT_PROPOSAL: 'project_proposal',
  PROJECT_DECISION: 'project_decision',
  // A project's estimated cost is waiting for the finance head / was decided (approved or sent back).
  PROJECT_COST_REQUEST: 'project_cost_request',
  PROJECT_COST_DECISION: 'project_cost_decision',
  // Spending on a project reached 80% of its approved budget / went past it.
  PROJECT_BUDGET_ALERT: 'project_budget_alert',
  // A project needs more people: the request reaching HR / its answers / a department head asked to release someone.
  MANPOWER_REQUEST: 'manpower_request',
  MANPOWER_UPDATE: 'manpower_update',
  MANPOWER_RELEASE: 'manpower_release',
  // The CEO / Executive Director: something needs their decision / it was decided / it was withdrawn / the rules for what reaches them changed.
  DECISION_REQUEST: 'decision_request',
  DECISION_RESULT: 'decision_result',
  DECISION_WITHDRAWN: 'decision_withdrawn',
  POLICY_CHANGED: 'policy_changed',
  CONSULTATION_ASSIGNED: 'consultation_assigned',
  CONSULTATION_CHANGED: 'consultation_changed',
  CONSULTATION_REMINDER: 'consultation_reminder',
  MARKETING_EOD_REMINDER: 'marketing_eod_reminder',
  MARKETING_EOD_MISSED_SUMMARY: 'marketing_eod_missed_summary',
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

/// Resolve active user ids whose ROLE grants a given feature permission.
/// Permission-driven, so custom roles (e.g. a "Project Head" role with the
/// `it` permission ticked) are reached — not just a single hardcoded role key.
export const getUserIdsByPermission = async (permission) => {
  if (!permission) return [];
  const roles = await Role.find({ permissions: permission, active: { $ne: false } })
    .select('key')
    .lean();
  const keys = roles.map((r) => r.key);
  return getUserIdsByRoles(keys);
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

/// Notify every user whose role grants a feature permission (see
/// getUserIdsByPermission). Used to reach the whole "IT team" regardless of
/// which role keys the admin set up.
export const notifyPermission = async ({ permission, ...rest }) => {
  const ids = await getUserIdsByPermission(permission);
  await notify({ ...rest, recipients: ids });
};
