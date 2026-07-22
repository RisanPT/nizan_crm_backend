import Role from '../models/Role.js';
import User from '../models/User.js';
import { PERMISSION_KEYS } from '../models/Role.js';

const ALL = [...PERMISSION_KEYS];

// Mirrors the hard-coded matrix that used to live in app_role.dart, so seeding
// reproduces today's behaviour exactly and nothing changes until an admin
// edits a role.
const DEFAULT_ROLES = [
  { key: 'admin', label: 'Administrator', homeRoute: '/', permissions: ALL },
  {
    key: 'manager',
    label: 'Manager',
    homeRoute: '/clients',
    permissions: ALL.filter((p) => p !== 'dashboard'),
  },
  {
    key: 'crm',
    label: 'CRM',
    homeRoute: '/booking/requests',
    permissions: ['clients', 'calendar', 'bookings', 'trials', 'staff'],
  },
  {
    key: 'sales',
    label: 'Sales',
    homeRoute: '/sales/leads',
    permissions: ['clients', 'calendar', 'bookings', 'sales'],
  },
  {
    key: 'artist',
    label: 'Artist',
    homeRoute: '/',
    permissions: ['dashboard', 'calendar', 'finance', 'leave'],
  },
  {
    key: 'accounts',
    label: 'Accounts',
    homeRoute: '/accounts/dashboard',
    permissions: ['calendar', 'bookings', 'sales', 'finance', 'payables'],
  },
  {
    key: 'fleet_manager',
    label: 'Fleet Manager',
    homeRoute: '/fleet/assignments',
    permissions: ['calendar', 'fleet'],
  },
  { key: 'driver', label: 'Driver', homeRoute: '/driver/jobs', permissions: [] },
  {
    key: 'inventory_manager',
    label: 'Inventory Manager',
    homeRoute: '/inventory',
    permissions: ['inventory', 'payables'],
  },
  {
    key: 'marketing_admin',
    label: 'Marketing Admin',
    homeRoute: '/marketing/dashboard',
    permissions: ['marketing'],
  },
];

const sanitizePermissions = (input = []) =>
  (Array.isArray(input) ? input : [])
    .map((p) => String(p).trim().toLowerCase())
    .filter((p) => PERMISSION_KEYS.includes(p));

const slugify = (value = '') =>
  String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

/// Creates any missing default roles. Safe to call repeatedly — it never
/// overwrites permissions an admin has already customised.
export const ensureDefaultRoles = async () => {
  for (const def of DEFAULT_ROLES) {
    const existing = await Role.findOne({ key: def.key });
    if (!existing) {
      await Role.create({ ...def, isSystem: true });
    }
  }
};

export const getPermissionCatalogue = async (_req, res) => {
  res.json({ permissions: PERMISSION_KEYS });
};

export const getRoles = async (_req, res) => {
  try {
    await ensureDefaultRoles();
    const roles = await Role.find({}).sort({ isSystem: -1, label: 1 }).lean();

    // Attach how many users sit on each role so the UI can warn before changes.
    const counts = await User.aggregate([
      { $group: { _id: '$role', count: { $sum: 1 } } },
    ]);
    const countMap = new Map(counts.map((c) => [c._id, c.count]));

    res.json(
      roles.map((r) => ({ ...r, userCount: countMap.get(r.key) ?? 0 }))
    );
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const createRole = async (req, res) => {
  try {
    const { label, permissions, homeRoute } = req.body;
    const trimmedLabel = String(label ?? '').trim();
    if (!trimmedLabel) {
      return res.status(400).json({ message: 'Role name is required.' });
    }

    const key = slugify(req.body.key || trimmedLabel);
    if (!key) {
      return res.status(400).json({ message: 'Invalid role name.' });
    }
    if (await Role.findOne({ key })) {
      return res.status(400).json({ message: 'A role with this name already exists.' });
    }

    const role = await Role.create({
      key,
      label: trimmedLabel,
      permissions: sanitizePermissions(permissions),
      homeRoute: String(homeRoute ?? '/').trim() || '/',
      isSystem: false,
    });
    res.status(201).json(role);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateRole = async (req, res) => {
  try {
    const role = await Role.findById(req.params.id);
    if (!role) return res.status(404).json({ message: 'Role not found.' });

    const { label, permissions, homeRoute, active } = req.body;

    // Permissions and landing page are editable for every role; the key and
    // name of a system role stay fixed because other code branches on them.
    if (permissions !== undefined) {
      role.permissions = sanitizePermissions(permissions);
    }
    if (homeRoute !== undefined) {
      role.homeRoute = String(homeRoute).trim() || '/';
    }
    if (label !== undefined && !role.isSystem) {
      const trimmed = String(label).trim();
      if (trimmed) role.label = trimmed;
    }
    if (active !== undefined && !role.isSystem) {
      role.active = Boolean(active);
    }

    await role.save();
    res.json(role);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteRole = async (req, res) => {
  try {
    const role = await Role.findById(req.params.id);
    if (!role) return res.status(404).json({ message: 'Role not found.' });
    if (role.isSystem) {
      return res.status(400).json({ message: 'Built-in roles cannot be deleted.' });
    }

    const inUse = await User.countDocuments({ role: role.key });
    if (inUse > 0) {
      return res.status(400).json({
        message: `${inUse} user(s) still use this role. Reassign them first.`,
      });
    }

    await role.deleteOne();
    res.json({ message: 'Role deleted.' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/// Resolves the effective permission list for a role key.
export const permissionsForRole = async (roleKey) => {
  const role = await Role.findOne({ key: String(roleKey ?? '').trim().toLowerCase() }).lean();
  return role?.permissions ?? [];
};

/// Landing page configured for a role, used so custom roles know where to
/// send the user after login.
export const homeRouteForRole = async (roleKey) => {
  const role = await Role.findOne({ key: String(roleKey ?? '').trim().toLowerCase() }).lean();
  return role?.homeRoute ?? '';
};
