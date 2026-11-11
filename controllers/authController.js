import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import User from '../models/User.js';
import { permissionsForRole, ensureDefaultRoles, homeRouteForRole } from './roleController.js';
import Role from '../models/Role.js';
import Department from '../models/Department.js';
import Employee from '../models/Employee.js';
import { syncUserToEmployee } from '../utils/syncUserEmployee.js';
import { invalidateSalesRules } from '../utils/salesRules.js';
import { transporter, sendMail } from '../utils/mailer.js';
import {
  loginEmailFor, loginIdOf, expiryFromDay, loginExpired, canReuseDriverAccount, phoneDigits, EXPIRED_MESSAGE,
} from '../utils/driverLogin.js';
import { canManageUsers, authorizeUserChange, mayGiveRole } from '../utils/userAccess.js';

const NOT_ALLOWED_TO_MANAGE_USERS = 'You are not allowed to manage users.';

const generateToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '7d' });

// Resolve the display name of a user's department (empty when unset) so the app
// can show/lock "your department" without a second round-trip. Falls back to the
// user's linked Employee record so a department head is recognised even when
// only the Employee (not the User) carries the department.
const deptNameFor = async (user) => {
  if (user?.departmentId) {
    const dept = await Department.findById(user.departmentId).select('name').lean();
    if (dept?.name?.trim()) return dept.name.trim();
  }
  if (user?.employeeId) {
    const emp = await Employee.findById(user.employeeId)
      .select('department departmentId')
      .lean();
    if (emp?.departmentId) {
      const d = await Department.findById(emp.departmentId).select('name').lean();
      if (d?.name?.trim()) return d.name.trim();
    }
    if (emp?.department?.trim()) return emp.department.trim();
  }
  return '';
};

// Async because the role's feature permissions are resolved from the Role
// collection, so access changes take effect on the next login without a deploy.
const toAuthResponse = async (user) => ({
  token: generateToken(user._id.toString()),
  user: {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    role: user.role,
    permissions: await permissionsForRole(user.role),
    homeRoute: await homeRouteForRole(user.role),
    inventoryAccess: user.inventoryAccess ?? false,
    inventoryManage: user.inventoryManage ?? false,
    isDepartmentHead: user.isDepartmentHead ?? false,
    artistHead: user.artistHead ?? false,
    countInSalesTotals: user.countInSalesTotals !== false,
    managedBy: user.managedBy?.toString() ?? null,
    employeeId: user.employeeId?.toString() ?? null,
    departmentId: user.departmentId?.toString() ?? null,
    departmentName: await deptNameFor(user),
    zoneId: user.zoneId?.toString() ?? null,
    stateId: user.stateId?.toString() ?? null,
    regionId: user.regionId?.toString() ?? null,
    districtId: user.districtId?.toString() ?? null,
    pincodeId: user.pincodeId?.toString() ?? null,
  },
});

export const login = async (req, res) => {
  // The sign-in id is an email, or a mobile number for a driver who has no email.
  const email = loginEmailFor(req.body.email) ?? '';
  const password = String(req.body.password ?? '');

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required' });
  }

  if (!process.env.JWT_SECRET) {
    return res.status(500).json({ message: 'JWT_SECRET is not configured' });
  }

  const user = await User.findOne({ email });

  if (!user || !(await user.matchPassword(password)) || !user.active) {
    return res.status(401).json({ message: 'Invalid email or password' });
  }
  // Only said once the password was right, so it doesn't reveal which logins exist.
  if (loginExpired(user)) {
    return res.status(401).json({ message: EXPIRED_MESSAGE, code: 'LOGIN_EXPIRED' });
  }

  await ensureDefaultRoles();
  return res.json(await toAuthResponse(user));
};

export const getMe = async (req, res) => {
  return res.json({
    user: {
      id: req.user._id.toString(),
      name: req.user.name,
      email: req.user.email,
      role: req.user.role,
      permissions: await permissionsForRole(req.user.role),
      homeRoute: await homeRouteForRole(req.user.role),
      inventoryAccess: req.user.inventoryAccess ?? false,
      inventoryManage: req.user.inventoryManage ?? false,
      isDepartmentHead: req.user.isDepartmentHead ?? false,
      artistHead: req.user.artistHead ?? false,
      managedBy: req.user.managedBy?.toString() ?? null,
      employeeId: req.user.employeeId?.toString() ?? null,
      departmentId: req.user.departmentId?.toString() ?? null,
      departmentName: await deptNameFor(req.user),
      zoneId: req.user.zoneId?.toString() ?? null,
      stateId: req.user.stateId?.toString() ?? null,
      regionId: req.user.regionId?.toString() ?? null,
      districtId: req.user.districtId?.toString() ?? null,
      pincodeId: req.user.pincodeId?.toString() ?? null,
    },
  });
};

export const getUsers = async (req, res) => {
  const page = Number.parseInt(req.query.page, 10);
  const limit = Number.parseInt(req.query.limit, 10);

  if (Number.isFinite(page) || Number.isFinite(limit)) {
    const currentPage = Math.max(1, page || 1);
    const currentLimit = Math.min(100, Math.max(1, limit || 20));
    const skip = (currentPage - 1) * currentLimit;

    const [rawItems, totalItems] = await Promise.all([
      User.find({})
        .select('-password')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(currentLimit),
      User.countDocuments({}),
    ]);

    const items = rawItems.map((u) => ({
      _id: u._id.toString(),
      id: u._id.toString(),
      name: u.name,
      email: u.email,
      role: u.role,
      active: u.active,
      accessExpiresAt: u.accessExpiresAt ?? null,
      inventoryAccess: u.inventoryAccess ?? false,
      inventoryManage: u.inventoryManage ?? false,
      isDepartmentHead: u.isDepartmentHead ?? false,
      artistHead: u.artistHead ?? false,
      countInSalesTotals: u.countInSalesTotals !== false,
      managedBy: u.managedBy?.toString() ?? null,
      employeeId: u.employeeId?.toString() ?? null,
      departmentId: u.departmentId?.toString() ?? null,
      zoneId: u.zoneId?.toString() ?? null,
      stateId: u.stateId?.toString() ?? null,
      regionId: u.regionId?.toString() ?? null,
      districtId: u.districtId?.toString() ?? null,
      pincodeId: u.pincodeId?.toString() ?? null,
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
    }));

    return res.json({
      items,
      page: currentPage,
      limit: currentLimit,
      totalItems,
      totalPages: Math.max(1, Math.ceil(totalItems / currentLimit)),
    });
  }


  const users = await User.find({})
    .select('-password')
    .sort({ createdAt: -1 });

  // Explicitly serialize ObjectId fields so clients receive plain strings
  // instead of raw Mongoose ObjectId objects (fixes managedBy comparison
  // in the Flutter TeamManagementScreen).
  const serialized = users.map((u) => ({
    _id: u._id.toString(),
    id: u._id.toString(),
    name: u.name,
    email: u.email,
    role: u.role,
    active: u.active,
    accessExpiresAt: u.accessExpiresAt ?? null,
    inventoryAccess: u.inventoryAccess ?? false,
    inventoryManage: u.inventoryManage ?? false,
    isDepartmentHead: u.isDepartmentHead ?? false,
    artistHead: u.artistHead ?? false,
    countInSalesTotals: u.countInSalesTotals !== false,
    managedBy: u.managedBy?.toString() ?? null,
    employeeId: u.employeeId?.toString() ?? null,
    departmentId: u.departmentId?.toString() ?? null,
    zoneId: u.zoneId?.toString() ?? null,
    stateId: u.stateId?.toString() ?? null,
    regionId: u.regionId?.toString() ?? null,
    districtId: u.districtId?.toString() ?? null,
    pincodeId: u.pincodeId?.toString() ?? null,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  }));

  return res.json(serialized);
};

export const createUser = async (req, res) => {
  const name = String(req.body.name ?? '').trim();
  const email = String(req.body.email ?? '')
    .trim()
    .toLowerCase();
  const password = String(req.body.password ?? '').trim();
  const role = String(req.body.role ?? 'manager').trim().toLowerCase() || 'manager';
  const active = req.body.active ?? true;
  const employeeId = req.body.employeeId ?? null;

  // Authorization: admins/managers may add any user; a fleet manager may add
  // driver logins only. Department heads can manage their own team.
  const requesterRole = req.user?.role;
  const isFullAccess = requesterRole === 'admin' || requesterRole === 'manager';
  const isDepartmentHeadReq =
    req.user?.isDepartmentHead === true ||
    String(requesterRole).endsWith('_manager') ||
    String(requesterRole).endsWith('manager') ||
    String(requesterRole).endsWith('_admin') ||
    String(requesterRole).endsWith('admin') ||
    requesterRole === 'inventory_manager' ||
    requesterRole === 'marketing_admin';
  const fleetCanAddDriver =
    requesterRole === 'fleet_manager' && role === 'driver';
  
  if (!isFullAccess && !fleetCanAddDriver && !isDepartmentHeadReq) {
    return res
      .status(403)
      .json({ message: 'You are not allowed to create this type of user.' });
  }

  // The schema no longer enums roles, so validate against the Role collection.
  await ensureDefaultRoles();
  const roleDoc = await Role.findOne({ key: role });
  if (!roleDoc) {
    return res.status(400).json({ message: `Unknown role "${role}".` });
  }
  if (!mayGiveRole(req.user, role)) {
    return res.status(403).json({ message: 'Only an administrator can create the CEO account.' });
  }

  if (!name || !email || !password) {
    return res.status(400).json({
      message: 'Name, email, and password are required',
    });
  }

  const existingUser = await User.findOne({ email });
  if (existingUser) {
    return res.status(409).json({ message: 'A user with this email already exists' });
  }

  const user = await User.create({
    name,
    email,
    password,
    role,
    active: Boolean(active),
    inventoryAccess: Boolean(req.body.inventoryAccess),
    inventoryManage: Boolean(req.body.inventoryManage),
    isDepartmentHead: Boolean(req.body.isDepartmentHead),
    artistHead: Boolean(req.body.artistHead),
    countInSalesTotals: req.body.countInSalesTotals !== false,
    departmentId: req.body.departmentId || null,
    managedBy: isDepartmentHeadReq && !isFullAccess ? req.user._id : null,
    employeeId: employeeId || null,
    zoneId: req.body.zoneId || null,
    stateId: req.body.stateId || null,
    regionId: req.body.regionId || null,
    districtId: req.body.districtId || null,
  });

  try {
    await syncUserToEmployee(user);
  } catch (syncErr) {
    console.error('Error auto-syncing User to Employee:', syncErr.message);
  }

  return res.status(201).json({
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    role: user.role,
    inventoryAccess: user.inventoryAccess ?? false,
    inventoryManage: user.inventoryManage ?? false,
    isDepartmentHead: user.isDepartmentHead ?? false,
    artistHead: user.artistHead ?? false,
    countInSalesTotals: user.countInSalesTotals !== false,
    managedBy: user.managedBy?.toString() ?? null,
    employeeId: user.employeeId?.toString() ?? null,
    departmentId: user.departmentId?.toString() ?? null,
    zoneId: user.zoneId?.toString() ?? null,
    stateId: user.stateId?.toString() ?? null,
    regionId: user.regionId?.toString() ?? null,
    districtId: user.districtId?.toString() ?? null,
    pincodeId: user.pincodeId?.toString() ?? null,
    active: user.active,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  });
};

const FLEET_LOGIN_ROLES = ['admin', 'manager', 'fleet_manager'];

const driverLoginSummary = (user, created) => ({
  id: user._id.toString(),
  name: user.name,
  email: user.email,
  loginId: loginIdOf(user.email), // what the driver types to sign in
  role: user.role,
  active: user.active,
  accessExpiresAt: user.accessExpiresAt ?? null,
  created,
});

// Grant (or refresh) a driver's login. A fleet manager gives an outsourced driver a TEMPORARY
// login by passing `expiresOn` ('YYYY-MM-DD', valid through the end of that day); without it
// the login is permanent, as before. The driver signs in with the email, or — when there is
// none — their mobile number (`phone`).
//
// It only ever creates a driver account or refreshes THAT driver's own: an email that already
// belongs to anyone else's account (an admin, an artist, another driver) is refused rather than
// having its password and role overwritten.
export const grantDriverLogin = async (req, res) => {
  try {
    const requesterRole = req.user?.role;
    if (!FLEET_LOGIN_ROLES.includes(requesterRole)) {
      return res
        .status(403)
        .json({ message: 'You are not allowed to grant login access.' });
    }

    const name = String(req.body.name ?? '').trim();
    const password = String(req.body.password ?? '').trim();
    const employeeId = req.body.employeeId || null;
    const email = loginEmailFor(req.body.email) ?? (phoneDigits(req.body.phone) ? loginEmailFor(req.body.phone) : null);

    if (!email) {
      return res.status(400).json({
        message: 'Give the driver a login: an email address, or a mobile number if they have no email.',
      });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: 'The login password needs at least 6 characters.' });
    }
    const expiry = expiryFromDay(req.body.expiresOn);
    if (expiry.error) return res.status(400).json({ message: expiry.error });

    let user = await User.findOne({ email });
    const reuse = canReuseDriverAccount(user, employeeId);
    if (reuse.error) return res.status(409).json({ message: reuse.error });

    let created = false;
    if (user) {
      if (name) user.name = name;
      user.password = password; // hashed by the pre-save hook
      if (employeeId) user.employeeId = employeeId;
      user.active = true;
      user.accessExpiresAt = expiry.at;
      await user.save();
    } else {
      user = await User.create({
        name: name || email,
        email,
        password,
        role: 'driver',
        active: true,
        employeeId,
        accessExpiresAt: expiry.at,
      });
      created = true;
    }

    try {
      await syncUserToEmployee(user);
    } catch (syncErr) {
      console.error('Error auto-syncing driver User to Employee:', syncErr.message);
    }

    return res.status(created ? 201 : 200).json({
      ...driverLoginSummary(user, created),
      message: created ? 'Driver login created' : 'Driver login updated',
    });
  } catch (error) {
    // Pass the real message through: the error sanitizer turns duplicate /
    // validation errors into a readable 400/409 instead of a bare "Server error".
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Renew, end or switch off a driver's login — without touching its password
// @route   PUT /api/auth/users/driver-login/:employeeId   { expiresOn?: 'YYYY-MM-DD' | null, active?: bool }
// @access  Private (fleet_manager / manager / admin) — driver accounts only
//   expiresOn: a day = valid through it (renew / shorten); null = permanent
//   active:    false = switch it off now; true = back on
export const setDriverLoginAccess = async (req, res) => {
  try {
    if (!FLEET_LOGIN_ROLES.includes(req.user?.role)) {
      return res.status(403).json({ message: 'You are not allowed to change login access.' });
    }
    const user = await User.findOne({ employeeId: req.params.employeeId, role: 'driver' });
    if (!user) return res.status(404).json({ message: 'This driver has no login yet.' });

    if (req.body.expiresOn !== undefined) {
      const expiry = expiryFromDay(req.body.expiresOn);
      if (expiry.error) return res.status(400).json({ message: expiry.error });
      user.accessExpiresAt = expiry.at;
    }
    if (req.body.active !== undefined) user.active = Boolean(req.body.active);
    await user.save();

    return res.json({ ...driverLoginSummary(user, false), message: 'Driver login updated' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @route   PUT /api/auth/users/:id
// @access  Private — admin / manager, or a department head for their own team (utils/userAccess.js).
//          Checked before the lookup so a caller with no user-management rights learns nothing
//          about which ids exist.
export const updateUser = async (req, res) => {
  if (!canManageUsers(req.user)) {
    return res.status(403).json({ message: NOT_ALLOWED_TO_MANAGE_USERS });
  }

  const user = await User.findById(req.params.id);

  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }

  const verdict = authorizeUserChange(req.user, user, {
    nextRole: req.body.role == null ? undefined : req.body.role,
  });
  if (!verdict.ok) {
    return res.status(403).json({ message: verdict.message });
  }

  const nextEmail = req.body.email == null
    ? user.email
    : String(req.body.email).trim().toLowerCase();

  if (nextEmail != user.email) {
    const existingUser = await User.findOne({ email: nextEmail });
    if (existingUser && existingUser._id.toString() != user._id.toString()) {
      return res.status(409).json({ message: 'A user with this email already exists' });
    }
  }

  const nextActive = req.body.active == null ? user.active : Boolean(req.body.active);
  if (req.user._id.toString() == user._id.toString() && !nextActive) {
    return res.status(400).json({ message: 'You cannot deactivate your own account' });
  }

  user.name = req.body.name == null ? user.name : String(req.body.name).trim();
  user.email = nextEmail;
  user.role = req.body.role == null
    ? user.role
    : String(req.body.role).trim() || user.role;
  user.active = nextActive;
  if (req.body.inventoryAccess !== undefined) {
    user.inventoryAccess = Boolean(req.body.inventoryAccess);
  }
  if (req.body.inventoryManage !== undefined) {
    user.inventoryManage = Boolean(req.body.inventoryManage);
  }
  if (req.body.isDepartmentHead !== undefined) {
    user.isDepartmentHead = Boolean(req.body.isDepartmentHead);
  }
  if (req.body.artistHead !== undefined) {
    user.artistHead = Boolean(req.body.artistHead);
  }
  if (req.body.countInSalesTotals !== undefined) {
    user.countInSalesTotals = req.body.countInSalesTotals !== false;
    // Sales totals read this flag through a short cache — refresh it now.
    invalidateSalesRules();
  }
  if (req.body.employeeId !== undefined) {
    user.employeeId = req.body.employeeId || null;
  }
  if (req.body.departmentId !== undefined) {
    user.departmentId = req.body.departmentId || null;
  }
  if (req.body.zoneId !== undefined) {
    user.zoneId = req.body.zoneId || null;
  }
  if (req.body.stateId !== undefined) {
    user.stateId = req.body.stateId || null;
  }
  if (req.body.regionId !== undefined) {
    user.regionId = req.body.regionId || null;
  }
  if (req.body.districtId !== undefined) {
    user.districtId = req.body.districtId || null;
  }
  if (req.body.pincodeId !== undefined) {
    user.pincodeId = req.body.pincodeId || null;
  }

  const nextPassword = String(req.body.password ?? '').trim();
  if (nextPassword.length > 0) {
    user.password = nextPassword;
  }

  await user.save();

  try {
    await syncUserToEmployee(user);
  } catch (syncErr) {
    console.error('Error auto-syncing User to Employee on update:', syncErr.message);
  }

  return res.json({
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    role: user.role,
    inventoryAccess: user.inventoryAccess ?? false,
    inventoryManage: user.inventoryManage ?? false,
    isDepartmentHead: user.isDepartmentHead ?? false,
    artistHead: user.artistHead ?? false,
    countInSalesTotals: user.countInSalesTotals !== false,
    managedBy: user.managedBy?.toString() ?? null,
    employeeId: user.employeeId?.toString() ?? null,
    departmentId: user.departmentId?.toString() ?? null,
    zoneId: user.zoneId?.toString() ?? null,
    stateId: user.stateId?.toString() ?? null,
    regionId: user.regionId?.toString() ?? null,
    districtId: user.districtId?.toString() ?? null,
    pincodeId: user.pincodeId?.toString() ?? null,
    active: user.active,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  });
};

// @route   DELETE /api/auth/users/:id
// @access  Private — same people as updateUser (utils/userAccess.js)
export const deleteUser = async (req, res) => {
  if (!canManageUsers(req.user)) {
    return res.status(403).json({ message: NOT_ALLOWED_TO_MANAGE_USERS });
  }

  // Guard: cannot delete your own account
  if (req.user._id.toString() === req.params.id) {
    return res.status(400).json({ message: 'You cannot delete your own account' });
  }

  const target = await User.findById(req.params.id).select('role managedBy');
  if (!target) {
    return res.status(404).json({ message: 'User not found' });
  }

  const verdict = authorizeUserChange(req.user, target);
  if (!verdict.ok) {
    return res.status(403).json({ message: verdict.message });
  }

  await User.findByIdAndDelete(target._id);

  return res.json({ message: 'User deleted successfully', id: req.params.id });
};

// ─── Employee self-service (ESS) provisioning ──────────────────────────────
// HR creates a login for an Employee. The account starts with a random password
// and an emailed one-time "set your password" link, so no admin ever sets or
// sees the employee's password.

const SETUP_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const publicBase = (req) => {
  const env = (process.env.PUBLIC_API_URL || '').replace(/\/+$/, '');
  if (env) return env;
  return `${req.protocol}://${req.get('host')}`;
};

const hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');
const setupLink = (req, raw) => `${publicBase(req)}/api/auth/set-password/${raw}`;

// Store the hashed token + expiry on the user and return the raw token.
const issueSetupToken = async (user) => {
  const raw = crypto.randomBytes(24).toString('hex');
  user.passwordSetupToken = hashToken(raw);
  user.passwordSetupExpires = new Date(Date.now() + SETUP_TTL_MS);
  await user.save();
  return raw;
};

const sendSetupEmail = async (req, user, raw) => {
  if (!transporter) return false;
  const link = setupLink(req, raw);
  return sendMail(transporter, {
    from: process.env.NODEMAILER_EMAIL,
    to: user.email,
    subject: 'Set your Nizan CRM password',
    html:
      '<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto">' +
      `<h2 style="color:#601A29">Welcome to Nizan CRM</h2>` +
      `<p>Hi ${user.name || 'there'}, an account has been created for you.</p>` +
      '<p>Click the button below to set your password. This link expires in 7 days.</p>' +
      `<p><a href="${link}" style="display:inline-block;background:#601A29;color:#fff;` +
      'padding:12px 20px;border-radius:8px;text-decoration:none">Set my password</a></p>' +
      `<p style="color:#777;font-size:12px">Or paste this link: ${link}</p>` +
      '</div>',
  });
};

// @route POST /api/auth/provision-employee  { employeeId, role?, email? }
export const provisionEmployeeLogin = async (req, res) => {
  try {
    const requesterRole = String(req.user?.role || '').toLowerCase();
    const isFullAccess = requesterRole === 'admin' || requesterRole === 'manager';
    const isDeptHead = req.user?.isDepartmentHead === true;
    if (!isFullAccess && !isDeptHead) {
      return res.status(403).json({ message: 'You are not allowed to provision logins.' });
    }

    const employeeId = String(req.body.employeeId || '').trim();
    if (!employeeId) return res.status(400).json({ message: 'An employee is required' });

    const employee = await Employee.findById(employeeId);
    if (!employee) return res.status(404).json({ message: 'Employee not found' });

    const email = String(req.body.email || employee.email || '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ message: 'This employee has no email on file. Add an email first.' });
    }

    await ensureDefaultRoles();
    const role = String(req.body.role || 'employee').trim().toLowerCase() || 'employee';
    const roleDoc = await Role.findOne({ key: role });
    if (!roleDoc) return res.status(400).json({ message: `Unknown role "${role}".` });
    if (!mayGiveRole(req.user, role)) {
      return res.status(403).json({ message: 'Only an administrator can create the CEO account.' });
    }

    let user = await User.findOne({ email }).select('+passwordSetupToken +passwordSetupExpires');
    if (user && String(user.role).trim().toLowerCase() === 'ceo' && !mayGiveRole(req.user, 'ceo')) {
      return res.status(403).json({ message: 'Only an administrator can change the CEO account.' });
    }
    let created = false;
    if (user) {
      user.employeeId = employee._id;
      if (req.body.role) user.role = role;
      user.active = true;
      if (!user.name && employee.name) user.name = employee.name;
    } else {
      user = new User({
        name: employee.name || email,
        email,
        password: crypto.randomBytes(18).toString('hex'), // placeholder; replaced via the link
        role,
        active: true,
        employeeId: employee._id,
        departmentId: employee.departmentId || null,
      });
      created = true;
    }

    const raw = await issueSetupToken(user); // persists the user

    try {
      await syncUserToEmployee(user);
    } catch (syncErr) {
      console.error('Error syncing provisioned user to employee:', syncErr.message);
    }

    const emailSent = await sendSetupEmail(req, user, raw);
    return res.status(created ? 201 : 200).json({
      id: user._id.toString(),
      email: user.email,
      role: user.role,
      created,
      emailSent,
      // When mail isn't configured, hand the link back so HR can share it manually.
      setupLink: emailSent ? null : setupLink(req, raw),
      message: created ? 'Login created; set-password link issued.' : 'Login updated; set-password link issued.',
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @route POST /api/auth/provision-employees  — provision every active employee
// with an email who has no login yet.
export const bulkProvisionEmployees = async (req, res) => {
  try {
    const requesterRole = String(req.user?.role || '').toLowerCase();
    if (!['admin', 'manager'].includes(requesterRole)) {
      return res.status(403).json({ message: 'Only admins/managers can bulk-provision logins.' });
    }
    await ensureDefaultRoles();
    const employees = await Employee.find({ status: 'active', email: { $ne: '' } })
      .select('name email departmentId');

    let created = 0;
    let invited = 0;
    let skipped = 0;
    for (const emp of employees) {
      const email = String(emp.email || '').trim().toLowerCase();
      if (!email) { skipped += 1; continue; }
      let user = await User.findOne({ email });
      if (user) {
        if (!user.employeeId) {
          user.employeeId = emp._id;
          await user.save();
        }
        skipped += 1;
        continue;
      }
      user = new User({
        name: emp.name || email,
        email,
        password: crypto.randomBytes(18).toString('hex'),
        role: 'employee',
        active: true,
        employeeId: emp._id,
        departmentId: emp.departmentId || null,
      });
      const raw = await issueSetupToken(user);
      try {
        await syncUserToEmployee(user);
      } catch (syncErr) {
        console.error('bulk provision sync failed:', syncErr.message);
      }
      const sent = await sendSetupEmail(req, user, raw);
      created += 1;
      if (sent) invited += 1;
    }
    return res.json({ created, invited, skipped, total: employees.length });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Minimal, self-contained HTML (ASCII only) — served by the backend so the flow
// never depends on the SPA's routing. Mirrors the public review-form pattern.
const setPasswordPage = (req, { token = '', message = '', ok = false, heading = 'Set your password', hideForm = false } = {}) => {
  const postUrl = `${publicBase(req)}/api/auth/set-password`;
  const banner = message
    ? `<div class="banner ${ok ? 'ok' : 'err'}">${message}</div>`
    : '';
  const form = (ok || hideForm)
    ? ''
    : `<form id="f">
        <label>New password</label>
        <input id="p1" type="password" minlength="6" required placeholder="At least 6 characters" />
        <label>Confirm password</label>
        <input id="p2" type="password" minlength="6" required placeholder="Re-enter password" />
        <button type="submit">Set password</button>
        <div id="msg" class="msg"></div>
      </form>`;
  const script = (ok || hideForm)
    ? ''
    : "<script>" +
      "var f=document.getElementById('f');" +
      "f.addEventListener('submit',function(e){" +
      "e.preventDefault();" +
      "var p1=document.getElementById('p1').value;" +
      "var p2=document.getElementById('p2').value;" +
      "var m=document.getElementById('msg');" +
      "if(p1.length<6){m.textContent='Password must be at least 6 characters.';return;}" +
      "if(p1!==p2){m.textContent='Passwords do not match.';return;}" +
      "m.textContent='Saving...';" +
      "fetch('" + postUrl + "',{method:'POST',headers:{'Content-Type':'application/json'}," +
      "body:JSON.stringify({token:'" + token + "',password:p1})})" +
      ".then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});})" +
      ".then(function(x){if(x.ok){document.body.innerHTML='<div class=\"card\"><h1>Password set</h1>" +
      "<p>You can now sign in to Nizan CRM with your email and new password.</p></div>';}" +
      "else{m.textContent=(x.j&&x.j.message)||'Could not set password.';}})" +
      ".catch(function(){m.textContent='Network error. Please try again.';});" +
      "});" +
      "</script>";
  return `<!doctype html><html><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${heading}</title>
<style>
  body{font-family:Arial,sans-serif;background:#f4eef0;margin:0;padding:24px;color:#2b2b2b}
  .card{max-width:380px;margin:40px auto;background:#fff;border-radius:16px;padding:28px;
    box-shadow:0 10px 30px rgba(96,26,41,.12)}
  h1{color:#601A29;font-size:22px;margin:0 0 6px}
  p{color:#666;font-size:14px}
  label{display:block;font-size:13px;font-weight:600;margin:14px 0 4px}
  input{width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #ddd;border-radius:10px;font-size:15px}
  button{width:100%;margin-top:18px;background:#601A29;color:#fff;border:0;padding:13px;border-radius:10px;
    font-size:15px;font-weight:600;cursor:pointer}
  .msg{color:#b00020;font-size:13px;margin-top:10px;min-height:16px}
  .banner{padding:10px 12px;border-radius:10px;font-size:13px;margin-bottom:10px}
  .banner.err{background:#fde8ea;color:#b00020}
  .banner.ok{background:#e7f6ec;color:#1b7f3b}
</style></head>
<body><div class="card"><h1>${heading}</h1>
${hideForm ? '' : '<p>Create a password for your Nizan CRM account.</p>'}
${banner}${form}</div>${script}</body></html>`;
};

// @route GET /api/auth/set-password/:token  (public) — renders the form
export const renderSetPasswordPage = async (req, res) => {
  const raw = String(req.params.token || '');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  try {
    const user = await User.findOne({
      passwordSetupToken: hashToken(raw),
      passwordSetupExpires: { $gt: new Date() },
    }).select('_id');
    if (!user) {
      return res.status(400).send(
        setPasswordPage(req, {
          heading: 'Link expired',
          hideForm: true,
          message: 'This link is invalid or has expired. Ask HR to resend it.',
        }),
      );
    }
    return res.send(setPasswordPage(req, { token: raw }));
  } catch (error) {
    return res.status(500).send(
      setPasswordPage(req, {
        heading: 'Something went wrong',
        hideForm: true,
        message: 'Please try again later.',
      }),
    );
  }
};

// @route POST /api/auth/set-password  { token, password }  (public)
export const submitSetPassword = async (req, res) => {
  try {
    const raw = String(req.body.token || '');
    const password = String(req.body.password || '');
    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters.' });
    }
    const user = await User.findOne({
      passwordSetupToken: hashToken(raw),
      passwordSetupExpires: { $gt: new Date() },
    }).select('+passwordSetupToken +passwordSetupExpires');
    if (!user) {
      return res.status(400).json({ message: 'This link is invalid or has expired.' });
    }
    user.password = password; // hashed by the pre-save hook
    user.passwordSetupToken = null;
    user.passwordSetupExpires = null;
    user.active = true;
    await user.save();
    return res.json({ ok: true, message: 'Password set successfully.' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

