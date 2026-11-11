// Who may change or delete ANOTHER user's account (PUT / DELETE /api/auth/users/:id).
// Pure — no database — so the rules can be tested without one (tests/userAccess.test.js).
//
// Callers, as the Flutter app uses these endpoints:
//   • Settings → Users          — admin / manager (AppRole.isFullAccess)
//   • "My Team" screen          — department heads: users they created (managedBy) PLUS users whose
//                                 role their own role delegates (AppRole.allowedSubordinateRoles)
// Same "who counts as what" test createUser applies, so create / edit / delete agree.
//
//   admin                 everything
//   manager               everything except an admin account, and cannot give the admin / manager role
//   department head       only their own team (see above) — never an admin or manager account, never
//                         their own account, and never the admin / manager role
//   anyone else           nothing (a fleet manager is a department head whose delegated role is `driver`)

const lc = (v) => String(v ?? '').trim().toLowerCase();
const idOf = (v) => (v == null ? '' : String(v._id ?? v));

// Granting these is an admin's call; touching an admin account is too.
const ADMIN_ONLY_ROLES = ['admin', 'manager', 'ceo'];

// Port of AppRole.fromString + AppRole.allowedSubordinateRoles
// (Nizan_crm/lib/core/auth/app_role.dart): the roles a department head may manage and assign.
// A head whose role has no entry here manages their `managedBy` team only.
const ROLE_GROUP = {
  crm: 'crm', crm_manager: 'crm',
  sales: 'sales', sales_manager: 'sales', sales_executive: 'sales', salesmanager: 'sales',
  accounts: 'accounts', accounts_manager: 'accounts', accounts_executive: 'accounts', finance_head: 'accounts',
  fleet_manager: 'fleet', fleetmanager: 'fleet',
  inventory_manager: 'inventory', inventorymanager: 'inventory',
  marketing_admin: 'marketing', marketingadmin: 'marketing', marketing_manager: 'marketing', marketing_executive: 'marketing',
};
const GROUP_ROLES = {
  crm: ['crm', 'crm_manager'],
  sales: ['sales', 'sales_manager', 'sales_executive'],
  accounts: ['accounts', 'accounts_manager', 'accounts_executive'],
  fleet: ['driver'],
  inventory: ['inventory_manager', 'inventorymanager'],
  marketing: ['marketing_admin', 'marketingadmin', 'marketing_manager', 'marketing_executive'],
};
export const delegatedRoles = (role) => GROUP_ROLES[ROLE_GROUP[lc(role)]] ?? [];

// admin / manager = full access; a department head is the flag, or a *manager / *admin role
// (the test createUser uses, and the app's Access.of).
export const requesterKind = (user) => {
  const role = lc(user?.role);
  const admin = role === 'admin';
  const full = admin || role === 'manager';
  const head = !full && (user?.isDepartmentHead === true || role.endsWith('manager') || role.endsWith('admin'));
  return { admin, full, head };
};

/// The CEO login is an administrator's to give, whichever way an account is made (create, provision, edit).
export const mayGiveRole = (requester, role) => lc(role) !== 'ceo' || requesterKind(requester).admin;

export const canManageUsers = (user) => {
  const { full, head } = requesterKind(user);
  return full || head;
};

const no = (message) => ({ ok: false, message });

/**
 * May `requester` change `target`'s account (or delete it)?  `nextRole` is the role being asked for,
 * if any — only a real CHANGE counts, because the app re-sends the unchanged role on every save.
 * Returns { ok: true } or { ok: false, message } (the caller answers 403).
 */
export const authorizeUserChange = (requester, target, { nextRole } = {}) => {
  const me = requesterKind(requester);
  if (!me.full && !me.head) return no('You are not allowed to manage users.');

  const targetRole = lc(target?.role);
  if (!me.admin && targetRole === 'admin') return no('Only an administrator can change an administrator account.');
  if (!me.admin && targetRole === 'ceo') return no('Only an administrator can change the CEO account.');
  if (!me.full && ADMIN_ONLY_ROLES.includes(targetRole)) {
    return no('Only an administrator or manager can change a manager account.');
  }

  if (!me.full) {
    // A department head: their own team only, and not themselves (a head cannot widen their own
    // role / territory — the Team screen never lists them either).
    if (idOf(requester?._id) === idOf(target?._id)) return no('You cannot change your own account here.');
    const delegated = delegatedRoles(requester?.role);
    const onMyTeam =
      (target?.managedBy != null && idOf(target.managedBy) === idOf(requester?._id)) || delegated.includes(targetRole);
    if (!onMyTeam) return no('You can only manage the members of your own team.');
  }

  const role = lc(nextRole);
  if (role && role !== targetRole) {
    if (!me.admin && ADMIN_ONLY_ROLES.includes(role)) return no('Only an administrator can give the admin, manager or CEO role.');
    const delegated = me.full ? [] : delegatedRoles(requester?.role);
    if (!me.full && delegated.length && !delegated.includes(role)) {
      return no(`You can only give your team these roles: ${delegated.join(', ')}.`);
    }
  }
  return { ok: true };
};
