import SalesTarget from '../models/SalesTarget.js';
import User from '../models/User.js';
import {
  SALES_TARGET_ROLES,
  istDay,
  monthAchievement,
} from '../utils/salesAchievement.js';

// Monthly sales targets. Managers (admin, manager, sales managers) set a
// target per salesperson; every salesperson reads their own progress.

const role = (u) => String(u?.role ?? '').toLowerCase();

/// Admin / manager, or a sales manager (e.g. 'sales_manager').
const canSetTargets = (user) => {
  const r = role(user);
  return r === 'admin' || r === 'manager' || (r.startsWith('sales') && r.endsWith('manager'));
};

/// month/year from the query or body, defaulting to the current IST month.
const periodOf = (src = {}) => {
  const now = new Date(Date.now() + 330 * 60 * 1000);
  const month = Number.parseInt(src.month, 10) || now.getUTCMonth() + 1;
  const year = Number.parseInt(src.year, 10) || now.getUTCFullYear();
  if (month < 1 || month > 12 || year < 2000 || year > 2100) return null;
  return { month, year };
};

const daysIn = (month, year) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/// Days left in the month including today (IST); 0 for past months.
const daysLeftIn = (month, year) => {
  const now = new Date(Date.now() + 330 * 60 * 1000);
  const cur = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const sel = year * 12 + (month - 1);
  if (sel < cur) return 0;
  if (sel > cur) return daysIn(month, year);
  return daysIn(month, year) - istDay(new Date()) + 1;
};

const num = (v) => Math.max(0, Math.round(Number(v) || 0));

const targetJson = (t) =>
  t
    ? {
        salesTarget: t.salesTarget ?? 0,
        bookingsTarget: t.bookingsTarget ?? 0,
        note: t.note ?? '',
        setByName: t.setBy?.name ?? '',
        updatedAt: t.updatedAt ?? null,
      }
    : null;

// @route GET /api/sales-targets/me?month&year — own target + progress.
export const getMyTarget = async (req, res) => {
  try {
    const p = periodOf(req.query);
    if (!p) return res.status(400).json({ message: 'Invalid month or year.' });
    const [target, achievement] = await Promise.all([
      SalesTarget.findOne({ userId: req.user._id, month: p.month, year: p.year })
        .populate('setBy', 'name')
        .lean(),
      monthAchievement(p.month, p.year),
    ]);
    const mine = achievement.get(String(req.user._id));
    const days = daysIn(p.month, p.year);
    res.json({
      ...p,
      daysInMonth: days,
      daysLeft: daysLeftIn(p.month, p.year),
      target: targetJson(target),
      achieved: {
        salesValue: mine?.salesValue ?? 0,
        bookings: mine?.bookings ?? 0,
        daily: mine?.daily ?? Array(days).fill(0),
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route GET /api/sales-targets?month&year — every salesperson (managers).
export const getTeamTargets = async (req, res) => {
  try {
    if (!canSetTargets(req.user)) {
      return res.status(403).json({ message: 'Only sales managers can view team targets.' });
    }
    const p = periodOf(req.query);
    if (!p) return res.status(400).json({ message: 'Invalid month or year.' });

    const [targets, achievement] = await Promise.all([
      SalesTarget.find({ month: p.month, year: p.year }).populate('setBy', 'name').lean(),
      monthAchievement(p.month, p.year),
    ]);
    const targetByUser = new Map(targets.map((t) => [String(t.userId), t]));
    // Active salespeople, plus anyone who already has a target this month.
    const users = await User.find({
      $or: [
        { role: { $in: SALES_TARGET_ROLES }, active: { $ne: false } },
        { _id: { $in: targets.map((t) => t.userId) } },
      ],
    })
      .select('name role active')
      .sort({ name: 1 })
      .lean();

    const rows = users.map((u) => {
      const id = String(u._id);
      const a = achievement.get(id);
      return {
        user: { id, name: u.name, role: u.role, active: u.active !== false },
        target: targetJson(targetByUser.get(id)),
        achieved: { salesValue: a?.salesValue ?? 0, bookings: a?.bookings ?? 0 },
      };
    });
    const totals = rows.reduce(
      (t, r) => ({
        salesTarget: t.salesTarget + (r.target?.salesTarget ?? 0),
        bookingsTarget: t.bookingsTarget + (r.target?.bookingsTarget ?? 0),
        salesValue: t.salesValue + r.achieved.salesValue,
        bookings: t.bookings + r.achieved.bookings,
      }),
      { salesTarget: 0, bookingsTarget: 0, salesValue: 0, bookings: 0 }
    );
    res.json({
      ...p,
      daysInMonth: daysIn(p.month, p.year),
      daysLeft: daysLeftIn(p.month, p.year),
      rows,
      totals,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route PUT /api/sales-targets — { month, year, targets:[{userId, salesTarget,
// bookingsTarget, note}] }. A row with both targets 0 and no note is removed.
export const saveTargets = async (req, res) => {
  try {
    if (!canSetTargets(req.user)) {
      return res.status(403).json({ message: 'Only sales managers can set targets.' });
    }
    const p = periodOf(req.body);
    if (!p) return res.status(400).json({ message: 'Invalid month or year.' });
    const list = Array.isArray(req.body?.targets) ? req.body.targets : [];
    if (list.length === 0) return res.status(400).json({ message: 'No targets to save.' });

    const ops = list
      .filter((t) => t?.userId)
      .map((t) => {
        const filter = { userId: t.userId, month: p.month, year: p.year };
        const salesTarget = num(t.salesTarget);
        const bookingsTarget = num(t.bookingsTarget);
        const note = String(t.note ?? '').trim();
        if (salesTarget === 0 && bookingsTarget === 0 && !note) {
          return { deleteOne: { filter } };
        }
        return {
          updateOne: {
            filter,
            update: { $set: { salesTarget, bookingsTarget, note, setBy: req.user._id } },
            upsert: true,
          },
        };
      });
    if (ops.length) await SalesTarget.bulkWrite(ops, { ordered: false });
    res.json({ saved: ops.length, ...p });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route POST /api/sales-targets/copy — { month, year }: copies the previous
// month's targets into this month for people who have none yet.
export const copyLastMonth = async (req, res) => {
  try {
    if (!canSetTargets(req.user)) {
      return res.status(403).json({ message: 'Only sales managers can set targets.' });
    }
    const p = periodOf(req.body);
    if (!p) return res.status(400).json({ message: 'Invalid month or year.' });
    const prev = p.month === 1 ? { month: 12, year: p.year - 1 } : { month: p.month - 1, year: p.year };

    const [previous, existing] = await Promise.all([
      SalesTarget.find(prev).lean(),
      SalesTarget.find(p).select('userId').lean(),
    ]);
    const has = new Set(existing.map((t) => String(t.userId)));
    const docs = previous
      .filter((t) => !has.has(String(t.userId)))
      .map((t) => ({
        userId: t.userId,
        ...p,
        salesTarget: t.salesTarget,
        bookingsTarget: t.bookingsTarget,
        note: t.note,
        setBy: req.user._id,
      }));
    if (docs.length) await SalesTarget.insertMany(docs, { ordered: false });
    res.json({ copied: docs.length, skipped: previous.length - docs.length, ...p });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
