import mongoose from 'mongoose';
import SalesTarget from '../models/SalesTarget.js';
import CombinedSalesTarget from '../models/CombinedSalesTarget.js';
import User from '../models/User.js';
import {
  SALES_TARGET_ROLES,
  isSalesManagerRole,
  istDay,
  managerFigures,
  monthAchievement,
  rangeAchievement,
  teamRollup,
} from '../utils/salesAchievement.js';
import { serviceTypeOf } from './bookingMapController.js';

// Monthly sales targets. Managers (admin, manager, sales managers) set a
// target per salesperson; every salesperson reads their own progress.
// A sales manager's target is not set directly — it is the sum of every
// salesperson's target, and their achievement is the team's sales plus their
// own. Combined (pool) targets are shared goals the whole team works toward.

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

/// Everyone relevant to a month's targets: active salespeople and managers,
/// plus anyone who holds a target that month. Returns the month's targets,
/// those users, the achievement map and the team rollup.
const monthTeam = async (p) => {
  const [targets, achievement] = await Promise.all([
    SalesTarget.find({ month: p.month, year: p.year }).populate('setBy', 'name').lean(),
    monthAchievement(p.month, p.year),
  ]);
  const users = await User.find({
    $or: [
      { role: { $in: SALES_TARGET_ROLES }, active: { $ne: false } },
      { role: { $regex: /^sales.*manager$/i }, active: { $ne: false } },
      { _id: { $in: targets.map((t) => t.userId) } },
    ],
  })
    .select('name role active')
    .sort({ name: 1 })
    .lean();
  const roleOf = new Map(users.map((u) => [String(u._id), u.role]));
  // A target stored against a sales manager (from before targets rolled up)
  // is ignored — the manager's figure is always the team total.
  const targetByUser = new Map(
    targets.filter((t) => !isSalesManagerRole(roleOf.get(String(t.userId)))).map((t) => [String(t.userId), t])
  );
  const days = daysIn(p.month, p.year);
  const rollup = teamRollup(
    users.map((u) => ({ id: String(u._id), role: u.role })),
    targetByUser,
    achievement,
    days
  );
  return { users, targetByUser, achievement, rollup, days };
};

/// Target JSON for a sales manager: the team total, flagged as derived.
const derivedTargetJson = (rollup) => ({
  salesTarget: rollup.target.salesTarget,
  bookingsTarget: rollup.target.bookingsTarget,
  note: '',
  setByName: '',
  updatedAt: null,
  derived: true,
  teamSize: rollup.teamIds.length,
});

// @route GET /api/sales-targets/me?month&year — own target + progress.
// For a sales manager: the team's combined target and achievement.
export const getMyTarget = async (req, res) => {
  try {
    const p = periodOf(req.query);
    if (!p) return res.status(400).json({ message: 'Invalid month or year.' });
    const days = daysIn(p.month, p.year);
    const base = { ...p, daysInMonth: days, daysLeft: daysLeftIn(p.month, p.year) };

    if (isSalesManagerRole(req.user.role)) {
      const { achievement, rollup } = await monthTeam(p);
      const own = achievement.get(String(req.user._id));
      const m = managerFigures(rollup, own, days);
      return res.json({
        ...base,
        target: derivedTargetJson(rollup),
        achieved: m.achieved,
        own: { salesValue: own?.salesValue ?? 0, bookings: own?.bookings ?? 0 },
      });
    }

    const [target, achievement] = await Promise.all([
      SalesTarget.findOne({ userId: req.user._id, month: p.month, year: p.year })
        .populate('setBy', 'name')
        .lean(),
      monthAchievement(p.month, p.year),
    ]);
    const mine = achievement.get(String(req.user._id));
    res.json({
      ...base,
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

    const { users, targetByUser, achievement, rollup, days } = await monthTeam(p);

    // Sales managers first (their row is the team total), then everyone else.
    const ordered = [
      ...users.filter((u) => isSalesManagerRole(u.role)),
      ...users.filter((u) => !isSalesManagerRole(u.role)),
    ];
    let managersOwn = { salesValue: 0, bookings: 0 };
    const rows = ordered.map((u) => {
      const id = String(u._id);
      const a = achievement.get(id);
      const user = { id, name: u.name, role: u.role, active: u.active !== false };
      if (isSalesManagerRole(u.role)) {
        const m = managerFigures(rollup, a, days);
        managersOwn = {
          salesValue: managersOwn.salesValue + (a?.salesValue ?? 0),
          bookings: managersOwn.bookings + (a?.bookings ?? 0),
        };
        return {
          user,
          target: derivedTargetJson(rollup),
          achieved: { salesValue: m.achieved.salesValue, bookings: m.achieved.bookings },
          own: { salesValue: a?.salesValue ?? 0, bookings: a?.bookings ?? 0 },
        };
      }
      return {
        user,
        target: targetJson(targetByUser.get(id)),
        achieved: { salesValue: a?.salesValue ?? 0, bookings: a?.bookings ?? 0 },
      };
    });
    // Team totals = the salespeople's targets, achieved by them plus any
    // sales credited to managers directly (counted once, not per row).
    const totals = {
      salesTarget: rollup.target.salesTarget,
      bookingsTarget: rollup.target.bookingsTarget,
      salesValue: rollup.achieved.salesValue + managersOwn.salesValue,
      bookings: rollup.achieved.bookings + managersOwn.bookings,
    };
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

    // A sales manager's target is the team total — never stored directly.
    const ids = list.map((t) => t?.userId).filter((id) => mongoose.Types.ObjectId.isValid(String(id)));
    const managerIds = new Set(
      (await User.find({ _id: { $in: ids }, role: { $regex: /^sales.*manager$/i } }).select('_id').lean())
        .map((u) => String(u._id))
    );
    const ops = list
      .filter((t) => t?.userId && mongoose.Types.ObjectId.isValid(String(t.userId)))
      .filter((t) => !managerIds.has(String(t.userId)))
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
    res.json({ saved: ops.length, skippedManagers: managerIds.size, ...p });
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
    // Sales managers' targets roll up from the team, so none are copied.
    const managerIds = new Set(
      (await User.find({ _id: { $in: previous.map((t) => t.userId) }, role: { $regex: /^sales.*manager$/i } })
        .select('_id')
        .lean()).map((u) => String(u._id))
    );
    const docs = previous
      .filter((t) => !has.has(String(t.userId)) && !managerIds.has(String(t.userId)))
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

// ── Combined (pool) targets ──────────────────────────────────────────────────
// One goal the whole team shares: every salesperson's sales in the window
// count toward it. Achievement = bookings MADE in the window (IST), net of
// discount, credited to a sales-role user, optionally one package only.

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const istDayStart = (day) => new Date(`${day}T00:00:00+05:30`);
const todayIst = () => new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
const dayCount = (a, b) => Math.round((istDayStart(b) - istDayStart(a)) / 86400000) + 1;

/// Pure: progress + contributions for one combined target. `byUser` from
/// rangeAchievement; `members` = Map(id → { name, role }) of sales-role users.
export const combinedProgress = (target, byUser, members, today) => {
  const contributions = [];
  let salesValue = 0;
  let bookings = 0;
  for (const [id, a] of byUser) {
    const m = members.get(id);
    if (!m) continue; // only the sales team's bookings count
    salesValue += a.salesValue;
    bookings += a.bookings;
    contributions.push({ userId: id, name: m.name || 'Unknown', salesValue: a.salesValue, bookings: a.bookings });
  }
  contributions.sort((x, y) => y.salesValue - x.salesValue || y.bookings - x.bookings);
  const totalDays = dayCount(target.startDay, target.endDay);
  const daysLeft =
    today > target.endDay ? 0 : today < target.startDay ? totalDays : dayCount(today, target.endDay);
  const status = today < target.startDay ? 'upcoming' : today > target.endDay ? 'ended' : 'active';
  return { achieved: { salesValue, bookings }, contributions, totalDays, daysLeft, status };
};

const combinedJson = (t, progress) => ({
  id: String(t._id),
  title: t.title,
  startDay: t.startDay,
  endDay: t.endDay,
  salesTarget: t.salesTarget ?? 0,
  bookingsTarget: t.bookingsTarget ?? 0,
  service: t.service ?? '',
  note: t.note ?? '',
  setByName: t.setBy?.name ?? '',
  ...progress,
});

/// Validated combined-target fields from a request body, or an error string.
export const combinedInput = (body = {}) => {
  const title = String(body.title ?? '').trim();
  const startDay = String(body.startDay ?? '');
  const endDay = String(body.endDay ?? '');
  const salesTarget = num(body.salesTarget);
  const bookingsTarget = num(body.bookingsTarget);
  if (!title) return 'Give the target a name.';
  if (!DAY_RE.test(startDay) || !DAY_RE.test(endDay)) return 'Pick a start and end date.';
  if (endDay < startDay) return 'The end date is before the start date.';
  if (salesTarget === 0 && bookingsTarget === 0) return 'Set a sales value or a number of bookings.';
  return {
    title,
    startDay,
    endDay,
    salesTarget,
    bookingsTarget,
    service: String(body.service ?? '').trim(),
    note: String(body.note ?? '').trim(),
  };
};

// @route GET /api/sales-targets/combined?month&year — combined targets that
// overlap the month, with progress. Salespeople see the team total and only
// their own contribution; managers see everyone's.
export const getCombinedTargets = async (req, res) => {
  try {
    const p = periodOf(req.query);
    if (!p) return res.status(400).json({ message: 'Invalid month or year.' });
    const mm = String(p.month).padStart(2, '0');
    const monthStart = `${p.year}-${mm}-01`;
    const monthEnd = `${p.year}-${mm}-${String(daysIn(p.month, p.year)).padStart(2, '0')}`;
    const targets = await CombinedSalesTarget.find({ startDay: { $lte: monthEnd }, endDay: { $gte: monthStart } })
      .populate('setBy', 'name')
      .sort({ startDay: 1, createdAt: 1 })
      .lean();

    const team = await User.find({
      $or: [{ role: { $in: SALES_TARGET_ROLES } }, { role: { $regex: /^sales.*manager$/i } }],
    })
      .select('name role')
      .lean();
    const members = new Map(team.map((u) => [String(u._id), { name: u.name, role: u.role }]));
    const manager = canSetTargets(req.user);
    const me = String(req.user._id);
    const today = todayIst();

    const out = [];
    for (const t of targets) {
      const end = new Date(istDayStart(t.endDay).getTime() + 86400000);
      const byUser = await rangeAchievement(istDayStart(t.startDay), end, {
        service: t.service,
        serviceTypeOf,
      });
      const prog = combinedProgress(t, byUser, members, today);
      const mine = prog.contributions.find((c) => c.userId === me) ?? { salesValue: 0, bookings: 0 };
      out.push(
        combinedJson(t, {
          ...prog,
          contributors: prog.contributions.length,
          contributions: manager ? prog.contributions : prog.contributions.filter((c) => c.userId === me),
          mine: { salesValue: mine.salesValue, bookings: mine.bookings },
        })
      );
    }
    res.json({ ...p, canEdit: manager, targets: out });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route POST /api/sales-targets/combined — create a combined target.
export const createCombinedTarget = async (req, res) => {
  try {
    if (!canSetTargets(req.user)) {
      return res.status(403).json({ message: 'Only sales managers can set targets.' });
    }
    const input = combinedInput(req.body);
    if (typeof input === 'string') return res.status(400).json({ message: input });
    const doc = await CombinedSalesTarget.create({ ...input, setBy: req.user._id });
    res.status(201).json({ id: String(doc._id) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route PUT /api/sales-targets/combined/:id — edit a combined target.
export const updateCombinedTarget = async (req, res) => {
  try {
    if (!canSetTargets(req.user)) {
      return res.status(403).json({ message: 'Only sales managers can set targets.' });
    }
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Target not found.' });
    const input = combinedInput(req.body);
    if (typeof input === 'string') return res.status(400).json({ message: input });
    const doc = await CombinedSalesTarget.findByIdAndUpdate(
      req.params.id,
      { $set: { ...input, setBy: req.user._id } },
      { new: true }
    );
    if (!doc) return res.status(404).json({ message: 'Target not found.' });
    res.json({ id: String(doc._id) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route DELETE /api/sales-targets/combined/:id — remove a combined target.
export const deleteCombinedTarget = async (req, res) => {
  try {
    if (!canSetTargets(req.user)) {
      return res.status(403).json({ message: 'Only sales managers can set targets.' });
    }
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Target not found.' });
    const doc = await CombinedSalesTarget.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Target not found.' });
    res.json({ deleted: true });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
