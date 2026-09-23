import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { permissionsForRole } from '../controllers/roleController.js';

export const protect = async (req, res, next) => {
  const authHeader = req.headers.authorization ?? '';
  let token = '';

  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else if (req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ message: 'Not authorized, token missing' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');

    if (!user || !user.active) {
      return res.status(401).json({ message: 'Not authorized' });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Not authorized, token invalid' });
  }
};

export const admin = (req, res, next) => {
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    return res.status(401).json({ message: 'Not authorized as an admin' });
  }
};

// --- Role-driven feature permissions -------------------------------------
// Resolves the signed-in user's granted features from the editable Role record
// (Settings -> Roles & Permissions) and hangs them on req.user.permissions, so
// controllers can honour what an admin actually granted instead of a
// hard-coded role list. Mount AFTER protect, on the routers that need it.
//
// Cached briefly: this would otherwise add a Role lookup to every request on
// the routers that use it. A permission change still takes effect within the
// TTL, with no server restart needed.
const PERMISSION_TTL_MS = 30_000;
const permissionCache = new Map();

const cachedPermissionsForRole = async (roleKey) => {
  const key = String(roleKey ?? '').trim().toLowerCase();
  const cached = permissionCache.get(key);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const value = await permissionsForRole(key);
  permissionCache.set(key, { value, expiresAt: Date.now() + PERMISSION_TTL_MS });
  return value;
};

export const attachRolePermissions = async (req, res, next) => {
  try {
    req.user.permissions = await cachedPermissionsForRole(req.user?.role);
  } catch (error) {
    // Never block a request because the Role lookup failed — the controllers'
    // existing hard-coded role checks still apply as a fallback.
    req.user.permissions = [];
  }

  next();
};
