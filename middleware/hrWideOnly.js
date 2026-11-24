// HR-wide gate for routes that expose every employee's personal data
// (attendance, the PHP HR bridge). Allowed: admin / manager / hr logins,
// anyone whose role carries the `staff` module (or one of the extra keys), and
// the HR department head — the same "HR-wide" rule as utils/hrDeptScope.js.
// Everyone else (artists, drivers, sales, other department heads) gets 403.
// Mount after protect + attachRolePermissions.

import { isHrWide } from '../utils/hrDeptScope.js';

const roleOf = (u) => String(u?.role || '').trim().toLowerCase();

export const hrWideOnly = (moduleKeys = []) => async (req, res, next) => {
  try {
    if (roleOf(req.user) === 'hr' || (await isHrWide(req, ['staff', ...moduleKeys]))) return next();
    return res.status(403).json({ message: 'Only HR can view this' });
  } catch (err) {
    return next(err);
  }
};

export default hrWideOnly;
