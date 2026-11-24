// Leave desk (owner decisions 2026-11-13 / 2026-11-16): leave requests are
// seen, approved and rejected ONLY by logins whose role is `admin` or `hr`.
// Department does not matter (an Executive Coordinator in the HR department
// is not on the desk). Managers and department heads no longer decide or list
// other people's leave; everyone still sees their own leave.

import User from '../models/User.js';

export const LEAVE_DESK_ROLES = ['admin', 'hr'];

const roleOf = (u) => String(u?.role || '').trim().toLowerCase();

/// True for an admin or hr login.
export const isLeaveDeskUser = (user) => LEAVE_DESK_ROLES.includes(roleOf(user));

/// Same check for the request's user (async, cached on req, kept async so
/// callers don't change if the rule grows again).
export async function isLeaveDesk(req) {
  if (req._leaveDesk !== undefined) return req._leaveDesk;
  req._leaveDesk = isLeaveDeskUser(req.user);
  return req._leaveDesk;
}

/// Active admin and hr logins (for new-request notifications).
export async function leaveDeskUserIds() {
  const users = await User.find({
    active: { $ne: false },
    role: { $in: LEAVE_DESK_ROLES.map((r) => new RegExp(`^\\s*${r}\\s*$`, 'i')) },
  })
    .select('_id')
    .lean();
  return users.map((u) => u._id);
}
