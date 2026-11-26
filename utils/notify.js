import Notification from '../models/Notification.js';
import User from '../models/User.js';
import Role from '../models/Role.js';
import Department from '../models/Department.js';

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
  CONSULTATION_ASSIGNED: 'consultation_assigned',
  CONSULTATION_CHANGED: 'consultation_changed',
  CONSULTATION_REMINDER: 'consultation_reminder',
  // HRMS workflow (2026-11-26).
  PAYSLIP_READY: 'payslip_ready',
  PAYROLL_SUBMITTED: 'payroll_submitted',
  NEW_HIRE: 'new_hire',
  HIRING_PLAN_RAISED: 'hiring_plan_raised',
  OFFBOARDING_STARTED: 'offboarding_started',
  PROBATION_ENDING: 'probation_ending',
  MARKETING_EOD_REMINDER: 'marketing_eod_reminder',
  MARKETING_EOD_MISSED_SUMMARY: 'marketing_eod_missed_summary',
};

// Admins see EVERY notification (2026-11-26, replacing the old "month-end
// summary only" rule): notify() adds every active admin to each notification,
// whoever else it is for. Everyone else only gets what concerns their team.

const idStr = (v) => (v == null ? '' : String(v._id ?? v));

/// Sales-only roles: these belong to the Sales team wherever the user's
/// department is set (or not).
export const SALES_MANAGER_ROLES = ['sales_manager', 'regional_manager'];

/// The Sales team's leaders, who get the team-wide sales notifications (new
/// enquiry, missed follow-up, lost request, booking, client chat, reviews):
///  - anyone with a sales-only manager role;
///  - anyone with a manager role whose department is Sales;
///  - the head of the Sales department, whatever their role.
/// The general `manager` role alone is NOT enough, so managers of other teams
/// (marketing, HR…) no longer receive sales notifications. If no Sales
/// department exists at all, falls back to every manager role so sales alerts
/// never silently vanish.
export const getSalesLeadIds = async () => {
  const depts = await Department.find({ key: 'sales' }).select('_id').lean();
  const deptIds = depts.map((d) => d._id);
  if (deptIds.length === 0) return getUserIdsByRoles(MANAGER_ROLES);
  const users = await User.find({
    active: { $ne: false },
    $or: [
      { role: { $in: SALES_MANAGER_ROLES } },
      { role: { $in: MANAGER_ROLES }, departmentId: { $in: deptIds } },
      { isDepartmentHead: true, departmentId: { $in: deptIds } },
    ],
  }).select('_id');
  return users.map((u) => u._id);
};

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
  // false only for strictly personal notices sent in bulk (e.g. one "payslip
  // ready" per employee): admins then get a single summary from the caller
  // instead of dozens of copies.
  copyAdmins = true,
} = {}) => {
  try {
    const exclude = idStr(excludeUserId);
    const base = recipients.map(idStr).filter(Boolean);
    // Nobody to tell → nothing to copy admins on either.
    if (base.length === 0) return;
    // Admins get a copy of every notification (applied centrally, so every
    // controller and role fan-out obeys it).
    const adminIds = copyAdmins ? (await getUserIdsByRoles(ADMIN_ROLES)).map(idStr) : [];
    // Unique, non-empty recipient ids, minus the excluded actor.
    const ids = [...new Set([...base, ...adminIds])].filter((id) => id !== exclude);
    if (ids.length === 0) return;

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
