import jwt from 'jsonwebtoken';
import User from '../models/User.js';

const generateToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '7d' });

const toAuthResponse = (user) => ({
  token: generateToken(user._id.toString()),
  user: {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    role: user.role,
  },
});

export const login = async (req, res) => {
  const email = String(req.body.email ?? '')
    .trim()
    .toLowerCase();
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

  return res.json(toAuthResponse(user));
};

export const getMe = async (req, res) => {
  return res.json({
    user: {
      id: req.user._id.toString(),
      name: req.user.name,
      email: req.user.email,
      role: req.user.role,
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

    const [items, totalItems] = await Promise.all([
      User.find({})
        .select('-password')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(currentLimit),
      User.countDocuments({}),
    ]);

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

  return res.json(users);
};

export const createUser = async (req, res) => {
  const name = String(req.body.name ?? '').trim();
  const email = String(req.body.email ?? '')
    .trim()
    .toLowerCase();
  const password = String(req.body.password ?? '').trim();
  const role = String(req.body.role ?? 'manager').trim() || 'manager';
  const active = req.body.active ?? true;

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
  });

  return res.status(201).json({
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    role: user.role,
    active: user.active,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  });
};

export const updateUser = async (req, res) => {
  const user = await User.findById(req.params.id);

  if (!user) {
    return res.status(404).json({ message: 'User not found' });
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

  const nextPassword = String(req.body.password ?? '').trim();
  if (nextPassword.length > 0) {
    user.password = nextPassword;
  }

  await user.save();

  return res.json({
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    role: user.role,
    active: user.active,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  });
};
