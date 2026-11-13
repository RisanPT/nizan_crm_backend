// LEADERSHIP = the people who run the company and decide: the CEO and the Executive Director. One list, in one place, so a rule
// written for "the CEO" holds for both (view-only except the decisions they take, no pay or bank data, decisions routed to them).
// Pure — no database (tests/leadership.test.js).

export const LEADERSHIP_ROLES = ['ceo', 'executive_director'];

const lc = (v) => String(v ?? '').trim().toLowerCase();

/// Is this role key a leadership role?
export const isLeadershipRole = (role) => LEADERSHIP_ROLES.includes(lc(role));

/// Is this user a leadership login (CEO or Executive Director)?
export const isLeadership = (user) => isLeadershipRole(user?.role);

/// How the role reads on screen.
export const leadershipTitle = (role) => (lc(role) === 'executive_director' ? 'Executive Director' : 'CEO');

// What a leadership role must never be granted, whatever an admin ticks on the Roles screen. A parent key such as `staff` or
// `payables` opens salaries and bank screens (the HR gates match any `staff.*` sub-key as the whole module, and `payables` as
// `payables.admin_salaries`); `it` opens the full-database backup; `settings`/`compensation` are the keys to the system and to pay.
// Sub-keys that are about pay are listed too. Everything the default roles carry is untouched.
export const LEADERSHIP_BANNED_PERMISSIONS = [
  'staff',
  'payables',
  'company_finance',
  'it',
  'settings',
  'compensation',
  'recruitment',
  'offboarding',
  'hr_letters',
  'hr_files',
  'staff.salaries',
  'payables.admin_salaries',
  'payables.operations_salaries',
  'payables.hra',
];

/// [permissions] with anything banned for a leadership role taken out; any other role comes back unchanged.
export const clampPermissions = (roleKey, permissions) =>
  isLeadershipRole(roleKey) ? permissions.filter((p) => !LEADERSHIP_BANNED_PERMISSIONS.includes(lc(p))) : permissions;
