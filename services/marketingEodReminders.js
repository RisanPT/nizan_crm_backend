import {
  MarketingTeamMember,
  MarketingEodEntry,
  MarketingCalendarSetting,
  MarketingRole,
  MarketingMemberRole,
} from '../models/MarketingEod.js';
import Holiday from '../models/Holiday.js';
import User from '../models/User.js';
import Department from '../models/Department.js';
import { notify, NOTIFICATION_TYPES } from '../utils/notify.js';

// FR-11 — Missing-EOD reminders. In-app notifications only (WhatsApp is a later
// step). Nothing here runs unless startMarketingEodReminders() is called, and it
// can be switched off with MARKETING_EOD_REMINDERS=off.

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const istNow = (date = new Date()) => new Date(date.getTime() + IST_OFFSET_MS);
const istDateStr = (date = new Date()) => istNow(date).toISOString().slice(0, 10);
const istHHmm = (date = new Date()) => istNow(date).toISOString().slice(11, 16);

const dateStrToUtcDate = (dateStr) => new Date(`${dateStr}T00:00:00.000Z`);

const getSetting = async () =>
  (await MarketingCalendarSetting.findOne()) || { weeklyOff: 0, reminderTime: '19:00' };

// A working day for the whole department: not the weekly off, not a holiday.
const isWorkingDate = async (dateStr, weeklyOff) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (new Date(y, m - 1, d).getDay() === weeklyOff) return false;
  const start = dateStrToUtcDate(dateStr);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const holiday = await Holiday.findOne({ date: { $gte: start, $lt: end } });
  return !holiday;
};

const isInTenure = (member, dateStr) => {
  const from = member.activeFrom ? istDateStr(member.activeFrom) : null;
  const to = member.activeTo ? istDateStr(member.activeTo) : null;
  if (from && dateStr < from) return false;
  if (to && dateStr > to) return false;
  return true;
};

// The login user behind a team member: explicit link first, then exact name.
export const userForMember = async (member) => {
  if (member.userId) {
    const linked = await User.findOne({ _id: member.userId, active: { $ne: false } }).select('_id name');
    if (linked) return linked;
  }
  const name = String(member.name || '').trim().toLowerCase();
  if (!name) return null;
  const users = await User.find({ active: { $ne: false } }).select('_id name');
  return users.find((u) => String(u.name || '').trim().toLowerCase() === name) || null;
};

const hasReported = async (memberId, dateStr) => {
  const entry = await MarketingEodEntry.findOne({ memberId, entryDate: dateStr }).select('hoursWorked');
  return Boolean(entry && entry.hoursWorked > 0);
};

/**
 * Remind one member to file the EOD for [dateStr]. Used by the manager's
 * "Send Reminder" button and by the evening job. Returns { sent, reason }.
 */
export const sendMemberReminder = async (member, dateStr, actor = null) => {
  const user = await userForMember(member);
  if (!user) {
    return { sent: false, reason: `${member.shortName || member.name} has no linked ERP user to notify.` };
  }
  await notify({
    recipients: [user._id],
    type: NOTIFICATION_TYPES.MARKETING_EOD_REMINDER,
    title: 'Please file your EOD',
    body: `Your end-of-day report for ${dateStr} has not been filed yet.`,
    link: '/marketing/eod',
    forDate: dateStrToUtcDate(dateStr),
    createdBy: actor?._id || null,
    dedupe: true,
  });
  return { sent: true, reason: '' };
};

const managerUserIds = async () => {
  const ids = new Set();
  const mktDept = await Department.findOne({ key: 'marketing' }).select('_id');
  const direct = await User.find({
    active: { $ne: false },
    $or: [
      { role: { $in: ['marketing_admin', 'marketing_manager'] } },
      ...(mktDept ? [{ isDepartmentHead: true, departmentId: mktDept._id }] : []),
    ],
  }).select('_id');
  direct.forEach((u) => ids.add(String(u._id)));

  // Members whose current marketing role is "Marketing Manager".
  const mgrRole = await MarketingRole.findOne({ name: /^marketing manager$/i });
  if (mgrRole) {
    const rows = await MarketingMemberRole.find().sort({ fromMonth: 1 });
    const latest = new Map();
    rows.forEach((r) => latest.set(String(r.memberId), String(r.roleId)));
    const memberIds = [...latest.entries()].filter(([, r]) => r === String(mgrRole._id)).map(([m]) => m);
    const members = await MarketingTeamMember.find({ _id: { $in: memberIds }, isActive: true });
    for (const m of members) {
      const u = await userForMember(m);
      if (u) ids.add(String(u._id));
    }
  }
  return [...ids];
};

// Members with working-day tenure on [dateStr] who have no reported hours.
const membersMissing = async (dateStr) => {
  const members = await MarketingTeamMember.find({ isActive: true }).sort({ sortOrder: 1 });
  const missing = [];
  for (const m of members) {
    if (!isInTenure(m, dateStr)) continue;
    if (!(await hasReported(m._id, dateStr))) missing.push(m);
  }
  return missing;
};

export const runEveningReminders = async (now = new Date()) => {
  const today = istDateStr(now);
  const setting = await getSetting();
  if (!(await isWorkingDate(today, setting.weeklyOff))) return { sent: 0, skipped: 'not a working day' };

  let sent = 0;
  for (const m of await membersMissing(today)) {
    const result = await sendMemberReminder(m, today);
    if (result.sent) sent++;
  }
  return { sent };
};

export const runMorningManagerSummary = async (now = new Date()) => {
  const yesterday = istDateStr(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const setting = await getSetting();
  if (!(await isWorkingDate(yesterday, setting.weeklyOff))) return { sent: 0, skipped: 'not a working day' };

  const missing = await membersMissing(yesterday);
  if (missing.length === 0) return { sent: 0 };

  const recipients = await managerUserIds();
  await notify({
    recipients,
    type: NOTIFICATION_TYPES.MARKETING_EOD_MISSED_SUMMARY,
    title: `Missed EODs for ${yesterday}`,
    body: missing.map((m) => m.shortName || m.name).join(', '),
    link: '/marketing/eod',
    forDate: dateStrToUtcDate(yesterday),
    dedupe: true,
  });
  return { sent: missing.length };
};

const MORNING_TIME = '09:00';
const WINDOW_MINUTES = 4 * 60; // a late server start still catches up, within reason

const minutesOf = (hhmm) => {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
};

/** Starts the once-a-minute scheduler. Safe to call once at boot. */
export const startMarketingEodReminders = () => {
  if (String(process.env.MARKETING_EOD_REMINDERS || '').toLowerCase() === 'off') {
    console.log('[MarketingEOD] Reminders disabled (MARKETING_EOD_REMINDERS=off).');
    return null;
  }

  let lastEvening = '';
  let lastMorning = '';

  const tick = async () => {
    try {
      const now = new Date();
      const today = istDateStr(now);
      const nowMin = minutesOf(istHHmm(now));
      const setting = await getSetting();

      const eveningStart = minutesOf(setting.reminderTime || '19:00');
      if (lastEvening !== today && nowMin >= eveningStart && nowMin < eveningStart + WINDOW_MINUTES) {
        lastEvening = today;
        const r = await runEveningReminders(now);
        console.log('[MarketingEOD] Evening reminders:', JSON.stringify(r));
      }

      const morningStart = minutesOf(MORNING_TIME);
      if (lastMorning !== today && nowMin >= morningStart && nowMin < morningStart + WINDOW_MINUTES) {
        lastMorning = today;
        const r = await runMorningManagerSummary(now);
        console.log('[MarketingEOD] Morning manager summary:', JSON.stringify(r));
      }
    } catch (err) {
      console.error('[MarketingEOD] Reminder tick failed:', err?.message || err);
    }
  };

  const handle = setInterval(tick, 60 * 1000);
  console.log('[MarketingEOD] Reminder scheduler started.');
  return handle;
};
