import {
  MarketingGroup,
  MarketingRole,
  MarketingMetric,
  MarketingRoleMetric,
  MarketingTeamMember,
  MarketingMemberRole,
  MarketingMemberMetric,
  MarketingTarget,
  MarketingCalendarSetting,
  MarketingEodEntry,
  MarketingWeeklyPageStat,
  MarketingDashboardRemark,
  MarketingAuditLog,
  MarketingThreshold,
} from '../models/MarketingEod.js';
import Holiday from '../models/Holiday.js';
import User from '../models/User.js';
import Department from '../models/Department.js';
import { sendMemberReminder } from '../services/marketingEodReminders.js';
import { LEADERSHIP_ROLES } from '../utils/leadership.js';

// ── Helper: Format IST Date string (YYYY-MM-DD) ─────────────────────────────
const toDateStr = (date = new Date()) => {
  const d = new Date(date);
  // IST offset is UTC+5:30
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(d.getTime() + istOffset);
  return istDate.toISOString().slice(0, 10);
};

const toMonthStr = (date = new Date()) => toDateStr(date).slice(0, 7);

// ── Helper: Check if User has Marketing Manager / Admin role ────────────────
const isManagerOrAdmin = (user) => {
  if (!user) return false;
  const role = String(user.role || '').toLowerCase();
  if (role === 'admin' || role === 'marketing_admin' || role === 'marketing_manager' || role === 'manager') return true;
  // Set per request by attachMarketingAccess (needs a DB lookup).
  return user.isMarketingManager === true;
};

// Route middleware: flags the user as a Marketing Manager when their team-member
// record currently holds the "Marketing Manager" role, or they head the
// Marketing department. Keeps the sync access checks above data-driven.
export const attachMarketingAccess = async (req, res, next) => {
  try {
    const user = req.user;
    if (user && user.isMarketingManager === undefined) {
      let flag = false;
      const own = await findOwnMember(user);
      if (own) {
        const current = await MarketingMemberRole.findOne({ memberId: own._id })
          .sort({ fromMonth: -1 })
          .populate('roleId');
        flag = /^marketing manager$/i.test(current?.roleId?.name || '');
      }
      if (!flag && user.isDepartmentHead && user.departmentId) {
        const dept = await Department.findById(user.departmentId).select('key');
        flag = dept?.key === 'marketing';
      }
      user.isMarketingManager = flag;
    }
  } catch (err) {
    console.error('attachMarketingAccess failed:', err.message);
  }
  next();
};

// Management (read) users — SRS section 7. They see every dashboard and the
// Team Summary but never edit EOD numbers.
const MANAGEMENT_READ_ROLES = [...LEADERSHIP_ROLES, 'management', 'director'];
const canViewTeam = (user) =>
  isManagerOrAdmin(user) || MANAGEMENT_READ_ROLES.includes(String(user?.role || '').toLowerCase());

// Guard for write endpoints that only the Marketing Manager / Admin may use.
// Returns true when it already sent the 403 response.
const denyUnlessManager = (req, res) => {
  if (isManagerOrAdmin(req.user)) return false;
  res.status(403).json({ message: 'Only the Marketing Manager or Admin can do this.' });
  return true;
};

// Guard for views of whole-team data (Team Summary, Missed EODs, exports).
const denyUnlessTeamViewer = (req, res) => {
  if (canViewTeam(req.user)) return false;
  res.status(403).json({ message: 'Only the Marketing Manager or Management can view team data.' });
  return true;
};

const addMonths = (monthStr, delta) => {
  const [y, m] = monthStr.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

// ── Helper: Is this team member the logged-in user? ─────────────────────────
// Linked by userId; members not linked yet fall back to an exact (case-
// insensitive) name match, same as resolveMemberForUser used to.
const isOwnMember = (user, member) => {
  if (!user || !member) return false;
  if (member.userId) return String(member.userId) === String(user._id);
  return (
    String(member.name || '').trim().toLowerCase() ===
    String(user.name || '').trim().toLowerCase()
  );
};

const findOwnMember = async (user) => {
  if (!user) return null;
  let member = await MarketingTeamMember.findOne({ userId: user._id, isActive: true });
  if (member) return member;
  const name = String(user.name || '').trim().toLowerCase();
  if (!name) return null;
  const candidates = await MarketingTeamMember.find({ userId: null, isActive: true });
  return candidates.find((m) => String(m.name || '').trim().toLowerCase() === name) || null;
};

// ── Helper: Resolve Team Member for Logged-in User ──────────────────────────
// A requested memberId is returned as-is (callers must run canAccessMember).
// Only team viewers fall back to the first active member; a regular user who
// is not on the marketing team gets null instead of someone else's data.
const resolveMemberForUser = async (user, requestedMemberId = null) => {
  if (requestedMemberId) {
    const member = await MarketingTeamMember.findById(requestedMemberId);
    if (member) return member;
  }
  const own = await findOwnMember(user);
  if (own) return own;
  if (canViewTeam(user)) {
    return await MarketingTeamMember.findOne({ isActive: true }).sort({ sortOrder: 1 });
  }
  return null;
};

const canAccessMember = (user, member) => canViewTeam(user) || isOwnMember(user, member);

// A member counts in a month only while active (activeFrom/activeTo).
const isMemberActiveInMonth = (member, monthStr) => {
  const from = member.activeFrom ? toDateStr(member.activeFrom) : null;
  const to = member.activeTo ? toDateStr(member.activeTo) : null;
  if (from && from.slice(0, 7) > monthStr) return false;
  if (to && to.slice(0, 7) < monthStr) return false;
  return true;
};

// Members who belong in [monthStr]'s team views: active during that month, and
// a deactivated member stays visible for months in which they have EODs.
const membersForMonth = async (monthStr) => {
  const all = await MarketingTeamMember.find().sort({ sortOrder: 1 });
  const withData = new Set(
    (await MarketingEodEntry.distinct('memberId', {
      entryDate: { $gte: monthStr + '-01', $lte: monthStr + '-31' },
    })).map(String)
  );
  return all.filter(
    (m) => isMemberActiveInMonth(m, monthStr) && (m.isActive || withData.has(String(m._id)))
  );
};

// Another active team member already linked to this ERP user (or null).
const userLinkedElsewhere = async (userId, exceptMemberId) => {
  const filter = { userId, isActive: true };
  if (exceptMemberId) filter._id = { $ne: exceptMemberId };
  return MarketingTeamMember.findOne(filter).select('name');
};

const getCalendarSetting = async () =>
  (await MarketingCalendarSetting.findOne()) || {
    weeklyOff: 0,
    standardHours: 8,
    editWindowDays: 2,
    reminderTime: '19:00',
  };

const getThresholds = async () =>
  (await MarketingThreshold.findOne({ metricScope: 'default' })) || { greenMin: 100, amberMin: 70 };

// ── Helper: Calculate Working Days in Month ─────────────────────────────────
const calculateWorkingDays = async (year, month, activeFrom = null, weeklyOffDay = 0, activeTo = null) => {
  const daysInMonth = new Date(year, month, 0).getDate();
  const holidays = await Holiday.find({
    date: {
      $gte: new Date(Date.UTC(year, month - 1, 1)),
      $lte: new Date(Date.UTC(year, month - 1, daysInMonth, 23, 59, 59)),
    },
  });

  const holidayDates = new Set(
    holidays.map((h) => new Date(h.date).toISOString().slice(0, 10))
  );

  let workingDays = 0;
  const activeFromStr = activeFrom ? toDateStr(activeFrom) : null;
  const activeToStr = activeTo ? toDateStr(activeTo) : null;

  for (let d = 1; d <= daysInMonth; d++) {
    const dayDate = new Date(year, month - 1, d);
    const dayStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

    if (activeFromStr && dayStr < activeFromStr) continue;
    if (activeToStr && dayStr > activeToStr) continue;

    const dayOfWeek = dayDate.getDay();
    if (dayOfWeek === weeklyOffDay) continue; // Sunday or configured weekly off
    if (holidayDates.has(dayStr)) continue;   // Declared Holiday

    workingDays++;
  }

  return { workingDays, daysInMonth, holidayDates };
};

// ── Helper: working days elapsed (MTD) ──────────────────────────────────────
// Working days from the 1st up to and including `upToStr` (YYYY-MM-DD), using
// the same rules as calculateWorkingDays (weekly off, holidays, tenure).
// Past month → all its working days; future month → 0. Pure / no DB access.
const countWorkingDaysUpTo = (year, month, holidayDates, weeklyOffDay, upToStr, activeFrom = null, activeTo = null) => {
  const daysInMonth = new Date(year, month, 0).getDate();
  const activeFromStr = activeFrom ? toDateStr(activeFrom) : null;
  const activeToStr = activeTo ? toDateStr(activeTo) : null;
  let count = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const dayStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (dayStr > upToStr) break;
    if (activeFromStr && dayStr < activeFromStr) continue;
    if (activeToStr && dayStr > activeToStr) continue;
    if (new Date(year, month - 1, d).getDay() === weeklyOffDay) continue;
    if (holidayDates.has(dayStr)) continue;
    count++;
  }
  return count;
};

// Expected-by-today (pro-rated) target: monthly target × elapsed ÷ working days.
const proRate = (target, elapsed, workingDays) =>
  workingDays > 0 ? Math.round(((target * elapsed) / workingDays) * 10) / 10 : 0;

// ── Helper: Audit Log Record ────────────────────────────────────────────────
const logAudit = async ({ table, recordId, field, oldValue, newValue, user, reason }) => {
  try {
    await MarketingAuditLog.create({
      table,
      recordId: String(recordId),
      field: field || 'general',
      oldValue,
      newValue,
      userId: user?._id || null,
      userName: user?.name || 'System',
      reason: reason || '',
      at: new Date(),
    });
  } catch (err) {
    console.error('Audit log creation error:', err);
  }
};

// ── Helper: Replace a member's activity set from [month] onward (FR-17) ─────
// Earlier sets end the month BEFORE [month] (toMonth is inclusive in every
// query), so a change made in November never alters October.
const replaceMemberActivitySet = async (memberId, month, metricIds) => {
  await MarketingMemberMetric.deleteMany({ memberId, fromMonth: { $gte: month } });
  await MarketingMemberMetric.updateMany(
    {
      memberId,
      fromMonth: { $lt: month },
      $or: [{ toMonth: null }, { toMonth: { $gte: month } }],
    },
    { toMonth: addMonths(month, -1) }
  );
  const unique = [...new Set((metricIds || []).map(String))];
  if (unique.length > 0) {
    await MarketingMemberMetric.insertMany(
      unique.map((metricId) => ({ memberId, metricId, fromMonth: month, toMonth: null }))
    );
  }
};

// ============================================================================
// 1. SETUP & MASTER DATA (FR-1, FR-2, FR-4, FR-17)
// ============================================================================

export const getSetupData = async (req, res) => {
  try {
    const groups = await MarketingGroup.find().sort({ sortOrder: 1, name: 1 });
    const metrics = await MarketingMetric.find().sort({ sortOrder: 1, code: 1 });
    const roles = await MarketingRole.find().sort({ sortOrder: 1, name: 1 });
    const roleMetrics = await MarketingRoleMetric.find();
    const members = await MarketingTeamMember.find().sort({ sortOrder: 1, name: 1 });
    const memberRoles = await MarketingMemberRole.find().populate('roleId');
    const calendarSettings = (await MarketingCalendarSetting.findOne()) || {
      weeklyOff: 0,
      standardHours: 8,
      effectiveFrom: '2026-01-01',
    };
    const thresholds = (await MarketingThreshold.findOne({ metricScope: 'default' })) || {
      greenMin: 100,
      amberMin: 70,
    };

    res.json({
      groups,
      metrics,
      roles,
      roleMetrics,
      members,
      memberRoles,
      calendarSettings,
      thresholds,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const saveGroup = async (req, res) => {
  if (denyUnlessManager(req, res)) return;
  try {
    const { id, name, sortOrder, isActive } = req.body;
    let group;
    if (id) {
      const old = await MarketingGroup.findById(id);
      group = await MarketingGroup.findByIdAndUpdate(
        id,
        { name, sortOrder, isActive },
        { new: true }
      );
      await logAudit({
        table: 'mkt_group',
        recordId: id,
        oldValue: old,
        newValue: group,
        user: req.user,
        reason: 'Updated activity group',
      });
    } else {
      group = await MarketingGroup.create({ name, sortOrder, isActive });
      await logAudit({
        table: 'mkt_group',
        recordId: group._id,
        oldValue: null,
        newValue: group,
        user: req.user,
        reason: 'Created activity group',
      });
    }
    res.json(group);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

export const saveRole = async (req, res) => {
  if (denyUnlessManager(req, res)) return;
  try {
    const { id, name, sortOrder, isActive } = req.body;
    let role;
    if (id) {
      const old = await MarketingRole.findById(id);
      role = await MarketingRole.findByIdAndUpdate(
        id,
        { name, sortOrder, isActive },
        { new: true }
      );
      await logAudit({
        table: 'mkt_role',
        recordId: id,
        oldValue: old,
        newValue: role,
        user: req.user,
        reason: 'Updated role',
      });
    } else {
      role = await MarketingRole.create({ name, sortOrder, isActive });
      await logAudit({
        table: 'mkt_role',
        recordId: role._id,
        oldValue: null,
        newValue: role,
        user: req.user,
        reason: 'Created role',
      });
    }
    res.json(role);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

export const saveMetric = async (req, res) => {
  if (denyUnlessManager(req, res)) return;
  try {
    const { id, groupId, code, name, unitType, inTotalOutput, isActive, sortOrder, maxPerDay } = req.body;
    const ceiling =
      maxPerDay === '' || maxPerDay === null || maxPerDay === undefined ? null : Number(maxPerDay);
    if (ceiling !== null && (!Number.isFinite(ceiling) || ceiling <= 0)) {
      return res.status(400).json({ message: 'Daily ceiling must be a positive number or blank.' });
    }
    let metric;
    if (id) {
      const old = await MarketingMetric.findById(id);
      metric = await MarketingMetric.findByIdAndUpdate(
        id,
        { groupId, code, name, unitType, inTotalOutput, isActive, sortOrder, maxPerDay: ceiling },
        { new: true }
      );
      if (old && old.inTotalOutput !== metric.inTotalOutput) {
        // Open item 12.4: flag changes are always audit-logged.
        await logAudit({
          table: 'mkt_metric',
          recordId: id,
          field: 'inTotalOutput',
          oldValue: old.inTotalOutput,
          newValue: metric.inTotalOutput,
          user: req.user,
          reason: 'Changed "In Total Output" flag',
        });
      }
      await logAudit({
        table: 'mkt_metric',
        recordId: id,
        oldValue: old,
        newValue: metric,
        user: req.user,
        reason: 'Updated metric',
      });
    } else {
      const existing = await MarketingMetric.findOne({ code });
      if (existing) {
        return res.status(400).json({ message: `Metric with code ${code} already exists.` });
      }
      metric = await MarketingMetric.create({
        groupId,
        code,
        name,
        unitType,
        inTotalOutput,
        isActive,
        sortOrder,
        maxPerDay: ceiling,
      });
      await logAudit({
        table: 'mkt_metric',
        recordId: metric._id,
        oldValue: null,
        newValue: metric,
        user: req.user,
        reason: 'Created metric',
      });
    }
    res.json(metric);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

export const saveRoleProfile = async (req, res) => {
  if (denyUnlessManager(req, res)) return;
  try {
    const { roleId, metricIds, applyToExistingFromMonth } = req.body;
    if (!roleId) return res.status(400).json({ message: 'roleId is required' });

    // Update Role template
    await MarketingRoleMetric.deleteMany({ roleId });
    if (Array.isArray(metricIds) && metricIds.length > 0) {
      const inserts = metricIds.map((mId) => ({ roleId, metricId: mId }));
      await MarketingRoleMetric.insertMany(inserts);
    }

    // If manager chose to propagate to current members with this role from a month forward (FR-17)
    if (applyToExistingFromMonth) {
      // Only members whose role in that month is this role (role history is by month).
      const roleRows = await MarketingMemberRole.find({
        fromMonth: { $lte: applyToExistingFromMonth },
      }).sort({ fromMonth: 1 });
      const roleInMonth = new Map();
      for (const r of roleRows) roleInMonth.set(String(r.memberId), String(r.roleId));
      const membersWithRole = [...roleInMonth.entries()]
        .filter(([, rId]) => rId === String(roleId))
        .map(([mId]) => mId);

      for (const mId of membersWithRole) {
        await replaceMemberActivitySet(mId, applyToExistingFromMonth, Array.isArray(metricIds) ? metricIds : []);
      }
    }

    await logAudit({
      table: 'mkt_role_metric',
      recordId: roleId,
      oldValue: null,
      newValue: metricIds,
      user: req.user,
      reason: `Updated role profile for role ${roleId}`,
    });

    res.json({ message: 'Role profile updated successfully' });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

export const saveTeamMember = async (req, res) => {
  if (denyUnlessManager(req, res)) return;
  try {
    const { id, name, shortName, roleId, userId, activeFrom, activeTo, sortOrder, isActive, month } = req.body;
    const fromMonth = month || toMonthStr();

    let member;
    if (id) {
      // Only touch fields the caller sent: an edit that omits userId must not
      // unlink the member's ERP user.
      const patch = { name, shortName, activeFrom, activeTo, sortOrder, isActive };
      if (userId !== undefined) {
        const taken = userId ? await userLinkedElsewhere(userId, id) : null;
        if (taken) {
          return res.status(400).json({ message: 'That ERP user is already linked to ' + taken.name + '.' });
        }
        patch.userId = userId || null;
      }
      for (const key of Object.keys(patch)) if (patch[key] === undefined) delete patch[key];
      member = await MarketingTeamMember.findByIdAndUpdate(id, patch, { new: true });
      if (!member) return res.status(404).json({ message: 'Team member not found' });
      if (roleId) {
        // FR-1/FR-17: a changed role starts a new role-history row and the
        // member's activity set is regenerated from the new role profile.
        const currentRole = await MarketingMemberRole.findOne({
          memberId: id,
          fromMonth: { $lte: fromMonth },
        }).sort({ fromMonth: -1 });
        const roleChanged = !currentRole || String(currentRole.roleId) !== String(roleId);

        await MarketingMemberRole.findOneAndUpdate(
          { memberId: id, fromMonth },
          { memberId: id, roleId, fromMonth },
          { upsert: true }
        );

        if (roleChanged) {
          const roleMetrics = await MarketingRoleMetric.find({ roleId });
          await replaceMemberActivitySet(id, fromMonth, roleMetrics.map((rm) => rm.metricId));
        }
      }
    } else {
      const takenOnCreate = userId ? await userLinkedElsewhere(userId, null) : null;
      if (takenOnCreate) {
        return res.status(400).json({ message: 'That ERP user is already linked to ' + takenOnCreate.name + '.' });
      }
      member = await MarketingTeamMember.create({
        name,
        shortName,
        userId: userId || null,
        activeFrom: activeFrom || new Date(),
        activeTo: activeTo || null,
        sortOrder: sortOrder || 0,
        isActive: isActive !== false,
      });

      if (roleId) {
        await MarketingMemberRole.create({
          memberId: member._id,
          roleId,
          fromMonth,
        });

        // Auto-provision Member Activity Set from Role Profile template (FR-1, FR-17)
        const roleMetrics = await MarketingRoleMetric.find({ roleId });
        if (roleMetrics.length > 0) {
          const inserts = roleMetrics.map((rm) => ({
            memberId: member._id,
            metricId: rm.metricId,
            fromMonth,
            toMonth: null,
          }));
          await MarketingMemberMetric.insertMany(inserts);
        }
      }
    }

    await logAudit({
      table: 'mkt_team_member',
      recordId: member._id,
      oldValue: null,
      newValue: member,
      user: req.user,
      reason: id ? 'Updated team member' : 'Created team member',
    });

    res.json(member);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

export const getMemberMetrics = async (req, res) => {
  try {
    const { memberId, month } = req.query;
    const targetMonth = month || toMonthStr();

    const owner = await MarketingTeamMember.findById(memberId);
    if (!owner || !canAccessMember(req.user, owner)) {
      return res.status(403).json({ message: 'Not authorized to view this member.' });
    }

    // Find applicable metrics for this member in targetMonth:
    // fromMonth <= targetMonth and (toMonth == null || toMonth >= targetMonth)
    const activeSets = await MarketingMemberMetric.find({
      memberId,
      fromMonth: { $lte: targetMonth },
      $or: [{ toMonth: null }, { toMonth: { $gte: targetMonth } }],
    }).populate('metricId');

    const metrics = activeSets
      .map((s) => s.metricId)
      .filter((m) => m && m.isActive)
      .sort((a, b) => a.sortOrder - b.sortOrder);

    res.json(metrics);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const saveMemberMetrics = async (req, res) => {
  if (denyUnlessManager(req, res)) return;
  try {
    const { memberId, month, metricIds } = req.body;
    const targetMonth = month || toMonthStr();

    if (!memberId || !Array.isArray(metricIds)) {
      return res.status(400).json({ message: 'memberId and metricIds array required' });
    }

    await replaceMemberActivitySet(memberId, targetMonth, metricIds);

    await logAudit({
      table: 'mkt_member_metric',
      recordId: memberId,
      field: targetMonth,
      oldValue: null,
      newValue: metricIds,
      user: req.user,
      reason: `Updated member activity set for ${targetMonth}`,
    });

    res.json({ message: 'Member activity set updated successfully' });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// ============================================================================
// 2. MONTHLY TARGETS (FR-3)
// ============================================================================

export const getTargets = async (req, res) => {
  try {
    const { month } = req.query;
    const targetMonth = month || toMonthStr();

    const filter = { month: targetMonth };
    if (!canViewTeam(req.user)) {
      const own = await findOwnMember(req.user);
      if (!own) return res.json([]);
      filter.memberId = own._id; // members only see their own targets
    }
    const targets = await MarketingTarget.find(filter);
    res.json(targets);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const saveTargets = async (req, res) => {
  if (denyUnlessManager(req, res)) return;
  try {
    const { month, targetList } = req.body;
    const targetMonth = month || toMonthStr();

    if (!Array.isArray(targetList)) {
      return res.status(400).json({ message: 'targetList must be an array of { memberId, metricId, targetValue }' });
    }

    const results = [];
    for (const item of targetList) {
      const val = item.targetValue === '' || item.targetValue === null || item.targetValue === undefined
        ? null
        : Number(item.targetValue);

      const target = await MarketingTarget.findOneAndUpdate(
        { memberId: item.memberId, metricId: item.metricId, month: targetMonth },
        {
          memberId: item.memberId,
          metricId: item.metricId,
          month: targetMonth,
          targetValue: val,
          setBy: req.user?._id || null,
          setAt: new Date(),
        },
        { upsert: true, new: true }
      );
      results.push(target);
    }

    await logAudit({
      table: 'mkt_target',
      recordId: targetMonth,
      oldValue: null,
      newValue: targetList.length,
      user: req.user,
      reason: `Saved targets for ${targetMonth}`,
    });

    res.json({ message: 'Targets saved successfully', count: results.length });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

export const copyTargets = async (req, res) => {
  if (denyUnlessManager(req, res)) return;
  try {
    const { fromMonth, toMonth } = req.body;
    if (!fromMonth || !toMonth) {
      return res.status(400).json({ message: 'fromMonth and toMonth are required' });
    }

    const previousTargets = await MarketingTarget.find({ month: fromMonth });
    if (previousTargets.length === 0) {
      return res.status(404).json({ message: `No targets found for ${fromMonth}` });
    }

    let copiedCount = 0;
    for (const prev of previousTargets) {
      await MarketingTarget.findOneAndUpdate(
        { memberId: prev.memberId, metricId: prev.metricId, month: toMonth },
        {
          memberId: prev.memberId,
          metricId: prev.metricId,
          month: toMonth,
          targetValue: prev.targetValue,
          setBy: req.user?._id || null,
          setAt: new Date(),
        },
        { upsert: true }
      );
      copiedCount++;
    }

    await logAudit({
      table: 'mkt_target',
      recordId: toMonth,
      oldValue: fromMonth,
      newValue: copiedCount,
      user: req.user,
      reason: `Copied targets from ${fromMonth} to ${toMonth}`,
    });

    res.json({ message: `Copied ${copiedCount} targets from ${fromMonth} to ${toMonth}` });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// ============================================================================
// 3. DAILY EOD ENTRY (FR-5, FR-6, FR-7)
// ============================================================================

export const getEodEntry = async (req, res) => {
  try {
    const user = req.user;
    const dateStr = req.query.date || toDateStr();
    const monthStr = dateStr.slice(0, 7);
    const requestedMemberId = req.query.memberId;

    const member = await resolveMemberForUser(user, requestedMemberId);
    if (!member) {
      return res.status(404).json({ message: 'No Marketing team member found for this user.' });
    }

    if (!canAccessMember(user, member)) {
      return res.status(403).json({ message: 'You can only view your own EOD entry.' });
    }

    // Check if the current user has permission to edit this member's EOD
    const isManager = isManagerOrAdmin(user);
    const isSelf = isOwnMember(user, member);

    // Edit window check: Members can edit N days back (Open Item 12.2, Setup)
    const calSetting = await getCalendarSetting();
    const editWindow = calSetting.editWindowDays ?? 2;
    const today = toDateStr();
    const diffDays = Math.round((new Date(today) - new Date(dateStr)) / (1000 * 60 * 60 * 24));
    let canEdit = true;
    let editNotice = '';

    // Check Month Close Status
    const remarkDoc = await MarketingDashboardRemark.findOne({
      memberId: member._id,
      month: monthStr,
    });
    const isClosed = remarkDoc && remarkDoc.monthStatus === 'closed';

    if (isClosed) {
      // FR-12: after sign-off even the Manager must reopen the month first.
      canEdit = false;
      editNotice = isManager
        ? 'Month is closed and signed off. Reopen it in Month Close to edit.'
        : 'Month is closed and signed off. Contact Manager to reopen for edits.';
    } else if (diffDays > editWindow && !isManager) {
      canEdit = false;
      editNotice = `Edit window expired (more than ${editWindow} days ago). Requires Manager approval.`;
    } else if (!isSelf && !isManager) {
      canEdit = false;
      editNotice = 'You can only edit your own EOD entry.';
    }

    // A manager changing someone else's row, or a late row, must give a reason.
    const reasonRequired = isManager && (!isSelf || diffDays > editWindow);

    // Fetch member's applicable metrics for this month
    const memberMetrics = await MarketingMemberMetric.find({
      memberId: member._id,
      fromMonth: { $lte: monthStr },
      $or: [{ toMonth: null }, { toMonth: { $gte: monthStr } }],
    }).populate({
      path: 'metricId',
      populate: { path: 'groupId' },
    });

    // Also include any metric that has recorded values for this member in this entry
    const existingEntry = await MarketingEodEntry.findOne({
      memberId: member._id,
      entryDate: dateStr,
    });

    const activeMetricMap = new Map();
    for (const mm of memberMetrics) {
      if (mm.metricId && mm.metricId.isActive) {
        activeMetricMap.set(String(mm.metricId._id), mm.metricId);
      }
    }

    if (existingEntry && Array.isArray(existingEntry.values)) {
      for (const val of existingEntry.values) {
        const idStr = String(val.metricId);
        if (!activeMetricMap.has(idStr)) {
          const recordedMetric = await MarketingMetric.findById(val.metricId).populate('groupId');
          if (recordedMetric) {
            activeMetricMap.set(idStr, recordedMetric);
          }
        }
      }
    }

    const applicableMetrics = Array.from(activeMetricMap.values()).sort(
      (a, b) => (a.groupId?.sortOrder || 0) - (b.groupId?.sortOrder || 0) || a.sortOrder - b.sortOrder
    );

    // Group applicable metrics by Group
    const groupsMap = new Map();
    for (const m of applicableMetrics) {
      const gName = m.groupId?.name || 'General';
      if (!groupsMap.has(gName)) {
        groupsMap.set(gName, {
          groupId: m.groupId?._id,
          groupName: gName,
          sortOrder: m.groupId?.sortOrder || 99,
          metrics: [],
        });
      }
      groupsMap.get(gName).metrics.push(m);
    }

    const groupedMetrics = Array.from(groupsMap.values()).sort(
      (a, b) => a.sortOrder - b.sortOrder
    );

    // Calculate current live Total Output
    let currentTotalOutput = 0;
    const valueMap = {};
    if (existingEntry && Array.isArray(existingEntry.values)) {
      for (const v of existingEntry.values) {
        valueMap[String(v.metricId)] = v.value;
        const metricObj = activeMetricMap.get(String(v.metricId));
        if (metricObj && metricObj.inTotalOutput) {
          currentTotalOutput += v.value || 0;
        }
      }
    }

    res.json({
      member: {
        id: member._id,
        name: member.name,
        shortName: member.shortName,
      },
      entryDate: dateStr,
      canEdit,
      editNotice,
      isManager,
      reasonRequired,
      standardHours: calSetting.standardHours ?? 8,
      entry: existingEntry || {
        hoursWorked: 0,
        notes: '',
        checkStatus: 'OK',
        checkMessage: '',
      },
      values: valueMap,
      totalOutput: currentTotalOutput,
      groupedMetrics,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const saveEodEntry = async (req, res) => {
  try {
    const user = req.user;
    const { memberId, entryDate, hoursWorked, notes, values, overrideReason } = req.body;

    if (!memberId || !entryDate) {
      return res.status(400).json({ message: 'memberId and entryDate are required' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(entryDate))) {
      return res.status(400).json({ message: 'entryDate must be YYYY-MM-DD.' });
    }

    const member = await MarketingTeamMember.findById(memberId);
    if (!member) return res.status(404).json({ message: 'Team member not found' });

    const isManager = isManagerOrAdmin(user);
    const isSelf = isOwnMember(user, member);

    // Date validations
    const today = toDateStr();
    if (entryDate > today) {
      return res.status(400).json({ message: 'Future date entries are blocked.' });
    }

    const calSetting = await getCalendarSetting();
    const editWindow = calSetting.editWindowDays ?? 2;
    const diffDays = Math.round((new Date(today) - new Date(entryDate)) / (1000 * 60 * 60 * 24));
    const monthStr = entryDate.slice(0, 7);

    if (!isSelf && !isManager) {
      return res.status(403).json({ message: 'Not authorized to edit this member EOD.' });
    }

    // Check month status — FR-12: a signed-off month needs a Manager reopen first
    const remarkDoc = await MarketingDashboardRemark.findOne({
      memberId: member._id,
      month: monthStr,
    });
    if (remarkDoc && remarkDoc.monthStatus === 'closed') {
      return res.status(403).json({
        message: isManager
          ? 'This month is closed. Reopen it in Month Close before editing.'
          : 'This month is closed. Only the Manager can reopen it.',
      });
    }

    if (diffDays > editWindow && !isManager) {
      return res.status(403).json({ message: 'Edit window expired. Manager approval required.' });
    }

    // FR-15: manager overrides and late edits carry a mandatory reason.
    const needsReason = isManager && (!isSelf || diffDays > editWindow);
    if (needsReason && !String(overrideReason || '').trim()) {
      return res.status(400).json({
        message: 'A reason is required when editing another member\'s EOD or a late entry.',
        reasonRequired: true,
      });
    }

    const parsedHours = Number(hoursWorked) || 0;
    if (parsedHours < 0) {
      return res.status(400).json({ message: 'Hours worked cannot be negative.' });
    }
    if (parsedHours > 24) {
      return res.status(400).json({ message: 'Hours worked cannot be more than 24.' });
    }

    const oldEntry = await MarketingEodEntry.findOne({ memberId, entryDate });

    // FR-5: a member can only report activities in their set for the month
    // (plus anything already recorded on this row). Managers may add any.
    const memberSet = await MarketingMemberMetric.find({
      memberId: member._id,
      fromMonth: { $lte: monthStr },
      $or: [{ toMonth: null }, { toMonth: { $gte: monthStr } }],
    });
    const allowedIds = new Set(memberSet.map((m) => String(m.metricId)));
    const previousIds = new Set((oldEntry?.values || []).map((v) => String(v.metricId)));

    const submitted = Array.isArray(values) ? values : [];
    const metricDocs = await MarketingMetric.find({
      _id: { $in: submitted.map((v) => v.metricId).filter(Boolean) },
    });
    const metricById = new Map(metricDocs.map((m) => [String(m._id), m]));

    // Format & validate metric values
    const cleanValues = [];
    const warnings = [];
    let hasCount = false;
    for (const item of submitted) {
      const idStr = String(item.metricId);
      const metric = metricById.get(idStr);
      if (!metric) {
        return res.status(400).json({ message: 'Unknown activity in the submitted values.' });
      }
      const val = Number(item.value) || 0;
      if (val < 0) {
        return res.status(400).json({ message: 'Metric values cannot be negative.' });
      }
      if (metric.unitType !== 'currency' && !Number.isInteger(val)) {
        return res.status(400).json({ message: metric.name + ' must be a whole number.' });
      }
      if (val > 0 && !isManager && !allowedIds.has(idStr) && !previousIds.has(idStr)) {
        return res.status(403).json({
          message: metric.name + ' is not one of your activities for this month.',
        });
      }
      if (val > 0 && !metric.isActive && !previousIds.has(idStr)) {
        return res.status(400).json({ message: metric.name + ' is no longer active.' });
      }
      if (metric.maxPerDay != null && val > metric.maxPerDay) {
        warnings.push(metric.name + ': ' + val + ' is above the usual daily maximum of ' + metric.maxPerDay + '.');
      }
      if (val > 0) hasCount = true;
      cleanValues.push({ metricId: item.metricId, value: val });
    }

    // Validation & Check Status (FR-6)
    let checkStatus = 'OK';
    let checkMessage = 'OK';
    if (parsedHours === 0 && hasCount) {
      checkStatus = 'WARNING';
      checkMessage = 'Hours missing: you entered counts but hours worked is 0.';
    } else if (parsedHours === 0 && !hasCount) {
      checkStatus = 'WARNING';
      checkMessage = 'No hours or counts reported for this day.';
    }

    const entry = await MarketingEodEntry.findOneAndUpdate(
      { memberId, entryDate },
      {
        memberId,
        entryDate,
        hoursWorked: parsedHours,
        notes: notes || '',
        checkStatus,
        checkMessage,
        values: cleanValues,
        submittedAt: oldEntry ? oldEntry.submittedAt : new Date(),
        lastEditedBy: user._id,
        lastEditedAt: new Date(),
      },
      { upsert: true, new: true }
    );

    // Audit log if manager edit on behalf of user, or late edit
    if (!isSelf || diffDays > editWindow || oldEntry) {
      await logAudit({
        table: 'mkt_eod_entry',
        recordId: entry._id,
        oldValue: oldEntry ? { hours: oldEntry.hoursWorked, values: oldEntry.values } : null,
        newValue: { hours: parsedHours, values: cleanValues },
        user,
        reason: String(overrideReason || '').trim() || (isSelf ? 'Member updated EOD' : 'Manager updated EOD on behalf of member'),
      });
    }

    res.json({ message: 'EOD entry saved successfully', entry, warnings });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// ============================================================================
// 4. INDIVIDUAL MONTHLY DASHBOARD (FR-8)
// ============================================================================

export const getIndividualDashboard = async (req, res) => {
  try {
    const user = req.user;
    const targetMonth = req.query.month || toMonthStr(); // YYYY-MM
    const requestedMemberId = req.query.memberId;

    const [yearStr, monthStr] = targetMonth.split('-');
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);

    const member = await resolveMemberForUser(user, requestedMemberId);
    if (!member) {
      return res.status(404).json({ message: 'Team member not found' });
    }
    if (!canAccessMember(user, member)) {
      return res.status(403).json({ message: 'You can only view your own dashboard.' });
    }
    const viewerIsTeam = canViewTeam(user);

    // Role in that month (FR-1: A member's role is stored by month)
    const roleHistory = await MarketingMemberRole.findOne({
      memberId: member._id,
      fromMonth: { $lte: targetMonth },
    })
      .sort({ fromMonth: -1 })
      .populate('roleId');

    const memberRoleName = roleHistory?.roleId?.name || 'Team Member';

    // Working calendar
    const calSetting = await getCalendarSetting();
    const thresholds = await getThresholds();
    const { workingDays, daysInMonth, holidayDates } = await calculateWorkingDays(
      year,
      month,
      member.activeFrom,
      calSetting.weeklyOff,
      member.activeTo
    );
    const activeFromStr = member.activeFrom ? toDateStr(member.activeFrom) : null;
    const activeToStr = member.activeTo ? toDateStr(member.activeTo) : null;

    // Applicable metrics for this member in targetMonth
    const memberMetrics = await MarketingMemberMetric.find({
      memberId: member._id,
      fromMonth: { $lte: targetMonth },
      $or: [{ toMonth: null }, { toMonth: { $gte: targetMonth } }],
    }).populate({
      path: 'metricId',
      populate: { path: 'groupId' },
    });

    // Targets for this member in targetMonth
    const targets = await MarketingTarget.find({
      memberId: member._id,
      month: targetMonth,
    });
    const targetMap = new Map();
    for (const t of targets) {
      targetMap.set(String(t.metricId), t.targetValue);
    }

    // All EOD entries for this member in targetMonth
    const startDateStr = `${targetMonth}-01`;
    const endDateStr = `${targetMonth}-${String(daysInMonth).padStart(2, '0')}`;
    const entries = await MarketingEodEntry.find({
      memberId: member._id,
      entryDate: { $gte: startDateStr, $lte: endDateStr },
    });

    // Map entries by date
    const entryByDate = new Map();
    for (const e of entries) {
      entryByDate.set(e.entryDate, e);
    }

    // Include any metric that has recorded values this month
    const metricMap = new Map();
    for (const mm of memberMetrics) {
      if (mm.metricId && mm.metricId.isActive) {
        metricMap.set(String(mm.metricId._id), mm.metricId);
      }
    }

    for (const e of entries) {
      if (Array.isArray(e.values)) {
        for (const v of e.values) {
          if (v.value > 0 && !metricMap.has(String(v.metricId))) {
            const extraMetric = await MarketingMetric.findById(v.metricId).populate('groupId');
            if (extraMetric) {
              metricMap.set(String(v.metricId), extraMetric);
            }
          }
        }
      }
    }

    const applicableMetrics = Array.from(metricMap.values()).sort(
      (a, b) => (a.groupId?.sortOrder || 0) - (b.groupId?.sortOrder || 0) || a.sortOrder - b.sortOrder
    );

    // Compute Days Reported & Hours Worked
    let daysReported = 0;
    let totalHoursWorked = 0;
    const dailyOutputs = new Map(); // dateStr -> totalOutput

    const todayStr = toDateStr();
    // MTD: working days elapsed so far (today counts) → pro-rated targets.
    const workingDaysElapsed = countWorkingDaysUpTo(
      year, month, holidayDates, calSetting.weeklyOff, todayStr, member.activeFrom, member.activeTo
    );
    let pacedMetricsCount = 0;
    let sumPacePct = 0;

    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${targetMonth}-${String(d).padStart(2, '0')}`;
      const entry = entryByDate.get(dateStr);
      let dayOutput = 0;

      if (entry) {
        if (entry.hoursWorked > 0) {
          daysReported++;
          totalHoursWorked += entry.hoursWorked;
        }
        if (Array.isArray(entry.values)) {
          for (const v of entry.values) {
            const m = metricMap.get(String(v.metricId));
            if (m && m.inTotalOutput) {
              dayOutput += v.value || 0;
            }
          }
        }
      }
      dailyOutputs.set(dateStr, dayOutput);
    }

    const avgHoursPerDay = daysReported > 0 ? (totalHoursWorked / daysReported).toFixed(1) : '0.0';
    const totalOutputMonth = Array.from(dailyOutputs.values()).reduce((sum, val) => sum + val, 0);

    // Compute Target vs. Achieved rows & Week-wise breakdown
    const activityRows = [];
    const weekWiseRows = [];
    let targetedMetricsCount = 0;
    let sumAchievedPct = 0;

    for (const metric of applicableMetrics) {
      const metricIdStr = String(metric._id);
      const targetVal = targetMap.has(metricIdStr) ? targetMap.get(metricIdStr) : null;

      let achievedMonth = 0;
      let bestDay = { count: 0, date: '—' };
      const weekSums = { W1: 0, W2: 0, W3: 0, W4: 0, W5: 0 };

      for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${targetMonth}-${String(d).padStart(2, '0')}`;
        const entry = entryByDate.get(dateStr);
        let val = 0;

        if (entry && Array.isArray(entry.values)) {
          const vObj = entry.values.find((x) => String(x.metricId) === metricIdStr);
          val = vObj ? vObj.value : 0;
        }

        achievedMonth += val;

        if (val > bestDay.count) {
          bestDay = { count: val, date: dateStr };
        }

        // Fixed week blocks (Section 4 FR-4)
        if (d >= 1 && d <= 7) weekSums.W1 += val;
        else if (d >= 8 && d <= 14) weekSums.W2 += val;
        else if (d >= 15 && d <= 21) weekSums.W3 += val;
        else if (d >= 22 && d <= 28) weekSums.W4 += val;
        else if (d >= 29) weekSums.W5 += val;
      }

      let achievedPct = null;
      let status = 'none';

      if (targetVal !== null && targetVal > 0) {
        achievedPct = Math.round((achievedMonth / targetVal) * 100);
        // Cap achieved percentage at 100% for summary tile average (SRS Open item 12.1)
        const cappedPct = Math.min(achievedPct, 100);
        sumAchievedPct += cappedPct;
        targetedMetricsCount++;

        if (achievedPct >= thresholds.greenMin) status = 'green';
        else if (achievedPct >= thresholds.amberMin) status = 'amber';
        else status = 'red';
      }

      // MTD vs pro-rated target ("expected by today")
      let expectedToDate = null;
      let pacePct = null;
      let paceStatus = 'none';
      if (targetVal !== null && targetVal > 0) {
        expectedToDate = proRate(targetVal, workingDaysElapsed, workingDays);
        if (expectedToDate > 0) {
          pacePct = Math.round((achievedMonth / expectedToDate) * 100);
          sumPacePct += Math.min(pacePct, 100);
          pacedMetricsCount++;
          if (pacePct >= thresholds.greenMin) paceStatus = 'green';
          else if (pacePct >= thresholds.amberMin) paceStatus = 'amber';
          else paceStatus = 'red';
        }
      }

      const dailyAvg = daysReported > 0 ? (achievedMonth / daysReported).toFixed(1) : '0.0';

      activityRows.push({
        expectedToDate,
        pacePct,
        paceStatus,
        metricId: metric._id,
        code: metric.code,
        name: metric.name,
        groupName: metric.groupId?.name || 'General',
        unitType: metric.unitType,
        inTotalOutput: metric.inTotalOutput,
        target: targetVal,
        achieved: achievedMonth,
        achievedPct,
        dailyAvg,
        bestDay,
        status,
      });

      weekWiseRows.push({
        metricId: metric._id,
        code: metric.code,
        name: metric.name,
        groupName: metric.groupId?.name || 'General',
        w1: weekSums.W1,
        w2: weekSums.W2,
        w3: weekSums.W3,
        w4: weekSums.W4,
        w5: weekSums.W5,
        monthTotal: achievedMonth,
      });
    }

    // Week-wise Total Output row
    const totalOutputWeeks = { W1: 0, W2: 0, W3: 0, W4: 0, W5: 0 };
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${targetMonth}-${String(d).padStart(2, '0')}`;
      const out = dailyOutputs.get(dateStr) || 0;
      if (d >= 1 && d <= 7) totalOutputWeeks.W1 += out;
      else if (d >= 8 && d <= 14) totalOutputWeeks.W2 += out;
      else if (d >= 15 && d <= 21) totalOutputWeeks.W3 += out;
      else if (d >= 22 && d <= 28) totalOutputWeeks.W4 += out;
      else if (d >= 29) totalOutputWeeks.W5 += out;
    }

    // Target Achieved Summary Tile (average of capped percentages)
    const targetAchievedTile = targetedMetricsCount > 0
      ? Math.round(sumAchievedPct / targetedMetricsCount)
      : 0;

    // Daily Calendar Grid (Red = missed working day, Grey = Sunday/holiday, Green = reported, Neutral = future)
    const dailyGrid = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${targetMonth}-${String(d).padStart(2, '0')}`;
      const dayDate = new Date(year, month - 1, d);
      const dayOfWeek = dayDate.getDay();
      const isSunday = dayOfWeek === calSetting.weeklyOff;
      const isHoliday = holidayDates.has(dateStr);
      const isFuture = dateStr > todayStr;
      const entry = entryByDate.get(dateStr);
      const hours = entry ? entry.hoursWorked : 0;
      const output = dailyOutputs.get(dateStr) || 0;

      // Days before the member joined / after they left are not working days
      // for them, so they are never marked as a missed EOD.
      const outsideTenure =
        (activeFromStr && dateStr < activeFromStr) || (activeToStr && dateStr > activeToStr);

      let color = 'neutral';
      if (isSunday || isHoliday || outsideTenure) {
        color = 'grey';
      } else if (isFuture) {
        color = 'future';
      } else if (hours > 0) {
        color = 'green';
      } else {
        color = 'red'; // Past working day missed!
      }

      dailyGrid.push({
        day: d,
        date: dateStr,
        dayOfWeek,
        hours,
        output,
        color,
        hasEod: Boolean(entry),
        // Open item 12.5: marker only, no payroll use.
        shortHours: hours > 0 && hours < (calSetting.standardHours ?? 8),
      });
    }

    // Monthly Remarks & Sign-off Doc
    let remarkDoc = (await MarketingDashboardRemark.findOne({
      memberId: member._id,
      month: targetMonth,
    })) || {
      highlights: '',
      managerRemarks: '',
      published: false,
      memberAckAt: null,
      managerSignedAt: null,
      monthStatus: 'open',
    };
    // FR-12: the member sees highlights/remarks only after the Manager publishes.
    if (!viewerIsTeam && !remarkDoc.published) {
      const plain = typeof remarkDoc.toObject === 'function' ? remarkDoc.toObject() : { ...remarkDoc };
      remarkDoc = { ...plain, highlights: '', managerRemarks: '' };
    }

    // Weekly Page Stats for roles with FR-18 enabled (e.g. Marketing Intern)
    const weeklyStats = await MarketingWeeklyPageStat.find({
      memberId: member._id,
      month: targetMonth,
    });

    res.json({
      member: {
        id: member._id,
        name: member.name,
        shortName: member.shortName,
        role: memberRoleName,
      },
      month: targetMonth,
      period: `01 ${new Date(year, month - 1, 1).toLocaleString('en', { month: 'short' })} – ${daysInMonth} ${new Date(year, month - 1, 1).toLocaleString('en', { month: 'short' })} ${year}`,
      summaryTiles: {
        daysReported: `${daysReported} of ${workingDays}`,
        totalOutput: totalOutputMonth,
        targetAchievedPct: targetAchievedTile,
        hoursWorked: `${totalHoursWorked} hrs (Avg ${avgHoursPerDay}/day)`,
        // MTD vs pro-rated target (average of capped pace %, like targetAchievedPct)
        mtdPacePct: pacedMetricsCount > 0 ? Math.round(sumPacePct / pacedMetricsCount) : null,
        workingDaysElapsed,
        workingDays,
      },
      activityNumbers: activityRows,
      weekWiseNumbers: {
        rows: weekWiseRows,
        totalOutputRow: {
          name: 'Total Output',
          w1: totalOutputWeeks.W1,
          w2: totalOutputWeeks.W2,
          w3: totalOutputWeeks.W3,
          w4: totalOutputWeeks.W4,
          w5: totalOutputWeeks.W5,
          monthTotal: totalOutputMonth,
        },
      },
      dailyGrid,
      remarks: remarkDoc,
      weeklyStats,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ============================================================================
// 5. TEAM SUMMARY (FR-9)
// ============================================================================

export const getTeamSummary = async (req, res) => {
  if (denyUnlessTeamViewer(req, res)) return;
  try {
    const targetMonth = req.query.month || toMonthStr();
    const [yearStr, monthStr] = targetMonth.split('-');
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);

    const calSetting = (await MarketingCalendarSetting.findOne()) || { weeklyOff: 0, standardHours: 8 };
    const { daysInMonth, holidayDates } = await calculateWorkingDays(year, month, null, calSetting.weeklyOff);
    const todayStr = toDateStr();
    const monthEndStr = `${targetMonth}-${String(daysInMonth).padStart(2, '0')}`;

    // Active members
    const members = await membersForMonth(targetMonth);
    const allMetrics = await MarketingMetric.find({ isActive: true })
      .populate('groupId')
      .sort({ 'groupId.sortOrder': 1, sortOrder: 1 });

    const startDateStr = `${targetMonth}-01`;
    const endDateStr = `${targetMonth}-${String(daysInMonth).padStart(2, '0')}`;

    // Load targets for month
    const allTargets = await MarketingTarget.find({ month: targetMonth });
    const targetLookup = new Map();
    for (const t of allTargets) {
      targetLookup.set(`${t.memberId}_${t.metricId}`, t.targetValue);
    }

    // Load member active sets for month
    const memberSets = await MarketingMemberMetric.find({
      fromMonth: { $lte: targetMonth },
      $or: [{ toMonth: null }, { toMonth: { $gte: targetMonth } }],
    });
    const memberMetricSet = new Set(
      memberSets.map((s) => `${s.memberId}_${s.metricId}`)
    );

    // Load all entries in month
    const entries = await MarketingEodEntry.find({
      entryDate: { $gte: startDateStr, $lte: endDateStr },
    });

    // Map: memberId -> { daysReported, hoursWorked, totalOutput, avgTargetAchieved, metricSums: { metricId -> sum } }
    const memberSummaries = {};

    for (const m of members) {
      memberSummaries[String(m._id)] = {
        memberId: m._id,
        name: m.shortName,
        fullName: m.name,
        daysReported: 0,
        hoursWorked: 0,
        totalOutput: 0,
        metricSums: {},
        targetedCount: 0,
        sumAchievedPct: 0,
        // MTD vs pro-rated target, per member's own working calendar/tenure
        workingDays: countWorkingDaysUpTo(year, month, holidayDates, calSetting.weeklyOff, monthEndStr, m.activeFrom, m.activeTo),
        workingDaysElapsed: countWorkingDaysUpTo(year, month, holidayDates, calSetting.weeklyOff, todayStr, m.activeFrom, m.activeTo),
        pacedCount: 0,
        sumPacePct: 0,
        mtdPacePct: null,
      };
    }

    // Process entries
    for (const e of entries) {
      const mSummary = memberSummaries[String(e.memberId)];
      if (!mSummary) continue;

      if (e.hoursWorked > 0) {
        mSummary.daysReported++;
        mSummary.hoursWorked += e.hoursWorked;
      }

      if (Array.isArray(e.values)) {
        for (const v of e.values) {
          const mIdStr = String(v.metricId);
          mSummary.metricSums[mIdStr] = (mSummary.metricSums[mIdStr] || 0) + (v.value || 0);
        }
      }
    }

    // Compute metrics and target achievement averages
    let teamTotalReported = 0;
    let teamTotalHours = 0;
    let teamTotalOutput = 0;
    let sumMemberAverages = 0;
    let membersWithTargets = 0;
    let sumMemberPace = 0;
    let membersWithPace = 0;

    for (const m of members) {
      const mSummary = memberSummaries[String(m._id)];
      let memberTotalOut = 0;

      for (const metric of allMetrics) {
        const mIdStr = String(metric._id);
        const val = mSummary.metricSums[mIdStr] || 0;
        if (metric.inTotalOutput) {
          memberTotalOut += val;
        }

        const isApplicable = memberMetricSet.has(`${m._id}_${metric._id}`);
        const target = targetLookup.get(`${m._id}_${metric._id}`);

        if (isApplicable && target !== null && target !== undefined && target > 0) {
          const pct = Math.min(Math.round((val / target) * 100), 100);
          mSummary.sumAchievedPct += pct;
          mSummary.targetedCount++;

          const expected = proRate(target, mSummary.workingDaysElapsed, mSummary.workingDays);
          if (expected > 0) {
            mSummary.sumPacePct += Math.min(Math.round((val / expected) * 100), 100);
            mSummary.pacedCount++;
          }
        }
      }

      mSummary.mtdPacePct = mSummary.pacedCount > 0
        ? Math.round(mSummary.sumPacePct / mSummary.pacedCount)
        : null;
      mSummary.totalOutput = memberTotalOut;
      mSummary.avgTargetAchieved = mSummary.targetedCount > 0
        ? Math.round(mSummary.sumAchievedPct / mSummary.targetedCount)
        : null;

      teamTotalReported += mSummary.daysReported;
      teamTotalHours += mSummary.hoursWorked;
      teamTotalOutput += memberTotalOut;

      if (mSummary.avgTargetAchieved !== null) {
        sumMemberAverages += mSummary.avgTargetAchieved;
        membersWithTargets++;
      }
      if (mSummary.mtdPacePct !== null) {
        sumMemberPace += mSummary.mtdPacePct;
        membersWithPace++;
      }
    }

    const teamAvgTargetAchieved = membersWithTargets > 0
      ? Math.round(sumMemberAverages / membersWithTargets)
      : 0;
    const teamMtdPace = membersWithPace > 0 ? Math.round(sumMemberPace / membersWithPace) : null;

    // Build Metric Rows
    const metricRows = [];
    for (const metric of allMetrics) {
      const mIdStr = String(metric._id);
      let metricTeamTotal = 0;
      let teamTarget = 0;
      let teamExpected = 0;
      const memberValues = {};

      for (const m of members) {
        const isApplicable = memberMetricSet.has(`${m._id}_${metric._id}`);
        const mSummary = memberSummaries[String(m._id)];
        const val = mSummary.metricSums[mIdStr] || 0;

        if (isApplicable || val > 0) {
          memberValues[String(m._id)] = val;
          metricTeamTotal += val;
        } else {
          memberValues[String(m._id)] = '—';
        }

        const target = targetLookup.get(`${m._id}_${metric._id}`);
        if (isApplicable && target > 0) {
          teamTarget += target;
          teamExpected += proRate(target, mSummary.workingDaysElapsed, mSummary.workingDays);
        }
      }
      teamExpected = Math.round(teamExpected * 10) / 10;

      metricRows.push({
        metricId: metric._id,
        code: metric.code,
        name: metric.name,
        groupName: metric.groupId?.name || 'General',
        unitType: metric.unitType,
        inTotalOutput: metric.inTotalOutput,
        memberValues,
        teamTotal: metricTeamTotal,
        // MTD vs pro-rated target, summed over members who have a target
        teamTarget: teamTarget > 0 ? teamTarget : null,
        teamExpected: teamTarget > 0 ? teamExpected : null,
        teamPacePct: teamExpected > 0 ? Math.round((metricTeamTotal / teamExpected) * 100) : null,
      });
    }

    res.json({
      month: targetMonth,
      members: members.map((m) => ({ id: m._id, name: m.shortName, fullName: m.name })),
      overviewRows: {
        daysReported: {
          label: 'Days Reported',
          memberValues: Object.fromEntries(members.map((m) => [String(m._id), memberSummaries[String(m._id)].daysReported])),
          teamTotal: teamTotalReported,
        },
        hoursWorked: {
          label: 'Hours Worked',
          memberValues: Object.fromEntries(members.map((m) => [String(m._id), memberSummaries[String(m._id)].hoursWorked])),
          teamTotal: teamTotalHours,
        },
        totalOutput: {
          label: 'Total Output',
          memberValues: Object.fromEntries(members.map((m) => [String(m._id), memberSummaries[String(m._id)].totalOutput])),
          teamTotal: teamTotalOutput,
        },
        avgTargetAchieved: {
          label: 'Avg Target Achieved',
          memberValues: Object.fromEntries(members.map((m) => [
            String(m._id),
            memberSummaries[String(m._id)].avgTargetAchieved !== null ? `${memberSummaries[String(m._id)].avgTargetAchieved}%` : '—',
          ])),
          teamTotal: `${teamAvgTargetAchieved}%`,
        },
        // MTD achieved vs expected-by-today (pro-rated target), avg of capped %
        mtdPace: {
          label: 'MTD vs Expected',
          memberValues: Object.fromEntries(members.map((m) => {
            const s = memberSummaries[String(m._id)];
            return [String(m._id), s.mtdPacePct !== null ? `${s.mtdPacePct}%` : '—'];
          })),
          teamTotal: teamMtdPace !== null ? `${teamMtdPace}%` : '—',
        },
        workingDaysElapsed: {
          label: 'Working Days (so far / month)',
          memberValues: Object.fromEntries(members.map((m) => {
            const s = memberSummaries[String(m._id)];
            return [String(m._id), `${s.workingDaysElapsed} / ${s.workingDays}`];
          })),
          teamTotal: '',
        },
      },
      metricRows,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ============================================================================
// 6. MISSED EODs TRACKER (FR-11)
// ============================================================================

export const getMissedEods = async (req, res) => {
  if (denyUnlessTeamViewer(req, res)) return;
  try {
    const targetMonth = req.query.month || toMonthStr();
    const [yearStr, monthStr] = targetMonth.split('-');
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);

    const members = await membersForMonth(targetMonth);
    const calSetting = (await MarketingCalendarSetting.findOne()) || { weeklyOff: 0, standardHours: 8 };

    const todayStr = toDateStr();
    const { daysInMonth, holidayDates } = await calculateWorkingDays(year, month, null, calSetting.weeklyOff);

    const startDateStr = `${targetMonth}-01`;
    const endDateStr = `${targetMonth}-${String(daysInMonth).padStart(2, '0')}`;

    const entries = await MarketingEodEntry.find({
      entryDate: { $gte: startDateStr, $lte: endDateStr },
    });

    const entrySet = new Set(
      entries.filter((e) => e.hoursWorked > 0).map((e) => `${e.memberId}_${e.entryDate}`)
    );

    const missedList = [];
    const memberMissedCounts = {};

    for (const m of members) {
      memberMissedCounts[String(m._id)] = 0;
      const activeFromStr = m.activeFrom ? toDateStr(m.activeFrom) : null;
      const activeToStr = m.activeTo ? toDateStr(m.activeTo) : null;

      for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${targetMonth}-${String(d).padStart(2, '0')}`;
        if (dateStr >= todayStr) continue; // Future or today not missed yet
        if (activeFromStr && dateStr < activeFromStr) continue;
        if (activeToStr && dateStr > activeToStr) continue;

        const dayDate = new Date(year, month - 1, d);
        if (dayDate.getDay() === calSetting.weeklyOff) continue;
        if (holidayDates.has(dateStr)) continue;

        const key = `${m._id}_${dateStr}`;
        if (!entrySet.has(key)) {
          missedList.push({
            memberId: m._id,
            memberName: m.name,
            shortName: m.shortName,
            date: dateStr,
          });
          memberMissedCounts[String(m._id)]++;
        }
      }
    }

    res.json({
      month: targetMonth,
      totalMissedCount: missedList.length,
      memberMissedCounts,
      missedList: missedList.sort((a, b) => b.date.localeCompare(a.date)),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ============================================================================
// 7. REMARKS, SIGN-OFF & MONTH CLOSE (FR-12)
// ============================================================================

export const saveRemarks = async (req, res) => {
  if (denyUnlessManager(req, res)) return;
  try {
    const { memberId, month, highlights, managerRemarks, published } = req.body;
    if (!memberId || !month) return res.status(400).json({ message: 'memberId and month are required' });

    const remarkDoc = await MarketingDashboardRemark.findOneAndUpdate(
      { memberId, month },
      {
        memberId,
        month,
        highlights: highlights || '',
        managerRemarks: managerRemarks || '',
        published: Boolean(published),
      },
      { upsert: true, new: true }
    );

    await logAudit({
      table: 'mkt_dashboard_remark',
      recordId: remarkDoc._id,
      oldValue: null,
      newValue: { highlights, managerRemarks, published },
      user: req.user,
      reason: 'Saved manager highlights and remarks',
    });

    res.json(remarkDoc);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

export const signOffMonth = async (req, res) => {
  try {
    const { memberId, month, action } = req.body; // action: 'member_ack' | 'manager_sign'
    const user = req.user;

    if (!memberId || !month) {
      return res.status(400).json({ message: 'memberId and month are required' });
    }
    if (action !== 'member_ack' && action !== 'manager_sign') {
      return res.status(400).json({ message: 'action must be member_ack or manager_sign' });
    }

    const member = await MarketingTeamMember.findById(memberId);
    if (!member) return res.status(404).json({ message: 'Team member not found' });

    // Manager signs and closes; the member may only acknowledge their own month.
    if (action === 'manager_sign') {
      if (denyUnlessManager(req, res)) return;
    } else if (!isOwnMember(user, member) && !isManagerOrAdmin(user)) {
      return res.status(403).json({ message: 'You can only acknowledge your own month.' });
    }

    const updates = {};
    if (action === 'member_ack') {
      updates.memberAckAt = new Date();
    } else {
      updates.managerSignedAt = new Date();
      updates.managerSignedBy = user._id;
      updates.monthStatus = 'closed'; // Closes month!
    }

    const updated = await MarketingDashboardRemark.findOneAndUpdate(
      { memberId, month },
      { $set: updates, $setOnInsert: { memberId, month } },
      { new: true, upsert: true }
    );

    await logAudit({
      table: 'mkt_dashboard_remark',
      recordId: updated._id,
      field: action,
      oldValue: null,
      newValue: updates,
      user,
      reason: 'Digital sign-off (' + action + ') for ' + month,
    });

    res.json(updated);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

export const reopenMonth = async (req, res) => {
  try {
    const { memberId, month, reason } = req.body;
    if (!isManagerOrAdmin(req.user)) {
      return res.status(403).json({ message: 'Only Manager/Admin can reopen a closed month.' });
    }
    if (!String(reason || '').trim()) {
      return res.status(400).json({ message: 'A reason is required to reopen a closed month.', reasonRequired: true });
    }

    const updated = await MarketingDashboardRemark.findOneAndUpdate(
      { memberId, month },
      { monthStatus: 'open' },
      { new: true }
    );
    if (!updated) {
      return res.status(404).json({ message: 'No closed month found for this member.' });
    }

    await logAudit({
      table: 'mkt_dashboard_remark',
      recordId: updated._id,
      field: 'monthStatus',
      oldValue: 'closed',
      newValue: 'open',
      user: req.user,
      reason: String(reason).trim(),
    });

    res.json({ message: 'Month reopened for editing', remark: updated });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// ============================================================================
// 8. WEEKLY PAGE PERFORMANCE STATS (FR-18)
// ============================================================================

export const getWeeklyPageStats = async (req, res) => {
  try {
    const { memberId, month } = req.query;
    const targetMonth = month || toMonthStr();

    const member = await MarketingTeamMember.findById(memberId);
    if (!member || !canAccessMember(req.user, member)) {
      return res.status(403).json({ message: 'Not authorized to view these stats.' });
    }

    const stats = await MarketingWeeklyPageStat.find({ memberId, month: targetMonth });
    res.json(stats);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const saveWeeklyPageStats = async (req, res) => {
  try {
    const { memberId, month, weekBlock, page, postsPublished, reach, engagement, notes } = req.body;
    if (!memberId || !month || !weekBlock || !page) {
      return res.status(400).json({ message: 'memberId, month, weekBlock, and page are required' });
    }

    const member = await MarketingTeamMember.findById(memberId);
    if (!member) return res.status(404).json({ message: 'Team member not found' });
    if (!isOwnMember(req.user, member) && !isManagerOrAdmin(req.user)) {
      return res.status(403).json({ message: 'You can only enter your own weekly stats.' });
    }

    const remarkDoc = await MarketingDashboardRemark.findOne({ memberId, month });
    if (remarkDoc && remarkDoc.monthStatus === 'closed') {
      return res.status(403).json({ message: 'This month is closed. Reopen it to edit.' });
    }

    const clean = {
      postsPublished: Number(postsPublished) || 0,
      reach: Number(reach) || 0,
      engagement: Number(engagement) || 0,
    };
    if (Object.values(clean).some((v) => v < 0 || !Number.isInteger(v))) {
      return res.status(400).json({ message: 'Weekly numbers must be whole numbers, zero or more.' });
    }

    const old = await MarketingWeeklyPageStat.findOne({ memberId, month, weekBlock, page });
    const stat = await MarketingWeeklyPageStat.findOneAndUpdate(
      { memberId, month, weekBlock, page },
      {
        memberId,
        month,
        weekBlock,
        page,
        ...clean,
        notes: notes || '',
        lastEditedBy: req.user?._id || null,
        lastEditedAt: new Date(),
      },
      { upsert: true, new: true }
    );

    // FR-18: edits are audited.
    await logAudit({
      table: 'mkt_weekly_page_stat',
      recordId: stat._id,
      field: month + ' ' + weekBlock + ' ' + page,
      oldValue: old ? { postsPublished: old.postsPublished, reach: old.reach, engagement: old.engagement } : null,
      newValue: clean,
      user: req.user,
      reason: old ? 'Updated weekly page stats' : 'Entered weekly page stats',
    });

    res.json(stat);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// ============================================================================
// 9. SETTINGS, AUDIT LOG, EXPORT & REMINDERS (FR-4, FR-11, FR-13, FR-15)
// ============================================================================

export const saveSettings = async (req, res) => {
  if (denyUnlessManager(req, res)) return;
  try {
    const { weeklyOff, standardHours, editWindowDays, reminderTime, greenMin, amberMin } = req.body;

    const update = {};
    if (weeklyOff !== undefined) {
      const v = Number(weeklyOff);
      if (!Number.isInteger(v) || v < 0 || v > 6) {
        return res.status(400).json({ message: 'Weekly off must be a day number 0 (Sunday) to 6.' });
      }
      update.weeklyOff = v;
    }
    if (standardHours !== undefined) {
      const v = Number(standardHours);
      if (!(v > 0 && v <= 24)) return res.status(400).json({ message: 'Standard hours must be between 1 and 24.' });
      update.standardHours = v;
    }
    if (editWindowDays !== undefined) {
      const v = Number(editWindowDays);
      if (!Number.isInteger(v) || v < 0 || v > 31) {
        return res.status(400).json({ message: 'Edit window must be 0 to 31 days.' });
      }
      update.editWindowDays = v;
    }
    if (reminderTime !== undefined) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(reminderTime))) {
        return res.status(400).json({ message: 'Reminder time must be HH:mm (24-hour).' });
      }
      update.reminderTime = String(reminderTime);
    }

    const old = await getCalendarSetting();
    const setting = await MarketingCalendarSetting.findOneAndUpdate({}, { $set: update }, { upsert: true, new: true });
    await logAudit({
      table: 'mkt_calendar_setting',
      recordId: setting._id,
      oldValue: {
        weeklyOff: old.weeklyOff,
        standardHours: old.standardHours,
        editWindowDays: old.editWindowDays,
        reminderTime: old.reminderTime,
      },
      newValue: update,
      user: req.user,
      reason: 'Updated calendar / EOD settings',
    });

    let thresholds = await getThresholds();
    if (greenMin !== undefined || amberMin !== undefined) {
      const g = Number(greenMin ?? thresholds.greenMin);
      const a = Number(amberMin ?? thresholds.amberMin);
      if (!(a >= 0 && g > a && g <= 100)) {
        return res.status(400).json({ message: 'Status thresholds need 0 <= amber < green <= 100.' });
      }
      const oldT = { greenMin: thresholds.greenMin, amberMin: thresholds.amberMin };
      thresholds = await MarketingThreshold.findOneAndUpdate(
        { metricScope: 'default' },
        { $set: { greenMin: g, amberMin: a } },
        { upsert: true, new: true }
      );
      await logAudit({
        table: 'mkt_threshold',
        recordId: thresholds._id,
        oldValue: oldT,
        newValue: { greenMin: g, amberMin: a },
        user: req.user,
        reason: 'Updated status colour thresholds',
      });
    }

    res.json({ settings: setting, thresholds });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

export const getAuditLog = async (req, res) => {
  if (denyUnlessManager(req, res)) return;
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const filter = {};
    if (req.query.table) filter.table = String(req.query.table);
    const logs = await MarketingAuditLog.find(filter).sort({ at: -1 }).limit(limit).lean();
    res.json(logs);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// FR-13: raw EOD records for a month (audits, backups). Returns table data;
// the app turns it into CSV.
export const exportRecords = async (req, res) => {
  if (denyUnlessTeamViewer(req, res)) return;
  try {
    const targetMonth = req.query.month || toMonthStr();
    if (!/^\d{4}-\d{2}$/.test(targetMonth)) {
      return res.status(400).json({ message: 'month must be YYYY-MM' });
    }

    const members = await membersForMonth(targetMonth);
    const memberById = new Map(members.map((m) => [String(m._id), m]));
    const entries = await MarketingEodEntry.find({
      memberId: { $in: members.map((m) => m._id) },
      entryDate: { $gte: `${targetMonth}-01`, $lte: `${targetMonth}-31` },
    }).sort({ entryDate: 1 });

    const metrics = await MarketingMetric.find().populate('groupId');
    metrics.sort(
      (a, b) => (a.groupId?.sortOrder || 0) - (b.groupId?.sortOrder || 0) || a.sortOrder - b.sortOrder
    );
    const usedIds = new Set();
    for (const e of entries) for (const v of e.values || []) if (v.value) usedIds.add(String(v.metricId));
    const cols = metrics.filter((m) => m.isActive || usedIds.has(String(m._id)));

    const headers = [
      'Date',
      'Team Member',
      'Hours Worked',
      ...cols.map((m) => `${m.groupId?.name || 'General'} - ${m.name}`),
      'Total Output',
      'Check',
      'Notes',
    ];
    const rows = entries.map((e) => {
      const byMetric = new Map((e.values || []).map((v) => [String(v.metricId), v.value]));
      const total = cols.reduce(
        (sum, m) => sum + (m.inTotalOutput ? byMetric.get(String(m._id)) || 0 : 0),
        0
      );
      return [
        e.entryDate,
        memberById.get(String(e.memberId))?.name || '',
        e.hoursWorked,
        ...cols.map((m) => byMetric.get(String(m._id)) || 0),
        total,
        e.checkStatus,
        e.notes || '',
      ];
    });

    res.json({ month: targetMonth, headers, rows });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// FR-11: manager nudges one member about a missed EOD.
export const sendReminder = async (req, res) => {
  if (denyUnlessManager(req, res)) return;
  try {
    const { memberId, date } = req.body;
    if (!memberId || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
      return res.status(400).json({ message: 'memberId and date (YYYY-MM-DD) are required.' });
    }
    const member = await MarketingTeamMember.findById(memberId);
    if (!member) return res.status(404).json({ message: 'Team member not found' });

    const result = await sendMemberReminder(member, date, req.user);
    if (!result.sent) return res.status(422).json({ message: result.reason });
    res.json({ message: `Reminder sent to ${member.shortName || member.name}.` });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Who am I in this module? Lets the app show only the tabs the user may use.
export const getMyAccess = async (req, res) => {
  try {
    const own = await findOwnMember(req.user);
    res.json({
      isManager: isManagerOrAdmin(req.user),
      canViewTeam: canViewTeam(req.user),
      memberId: own ? own._id : null,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Active ERP users, for linking a team member to their login (FR-1).
export const getLinkableUsers = async (req, res) => {
  if (denyUnlessManager(req, res)) return;
  try {
    const users = await User.find({ active: { $ne: false } })
      .select('name email role')
      .sort({ name: 1 })
      .lean();
    res.json(users);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
