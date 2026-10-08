import Notification from '../models/Notification.js';
import SalesTarget from '../models/SalesTarget.js';
import User from '../models/User.js';
import { NOTIFICATION_TYPES, notify } from './notify.js';
import { istDay, monthAchievement } from './salesAchievement.js';

// Mid-month target check. From the 15th (IST) each salesperson with a target
// gets ONE notification per month telling them where they stand, and each
// sales manager gets ONE team summary.
// There is no scheduler in this backend, so — like the month-end summary — it
// runs lazily when notifications are fetched, throttled to once an hour.

export const MID_MONTH_DAY = 15;
const CHECK_EVERY_MS = 60 * 60 * 1000;
let lastCheckAt = 0;

const IST_OFFSET_MS = 330 * 60 * 1000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const inr = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;

/// Pure: the notification text for one salesperson. `target` has
/// salesTarget / bookingsTarget; `achieved` has salesValue / bookings.
export const buildMidMonthMessage = ({ target, achieved, monthLabel, day, daysInMonth }) => {
  const hasValue = (target.salesTarget || 0) > 0;
  const hasCount = (target.bookingsTarget || 0) > 0;
  const pct = hasValue
    ? achieved.salesValue / target.salesTarget
    : hasCount
      ? achieved.bookings / target.bookingsTarget
      : 0;
  const pctText = `${Math.floor(pct * 100)}%`;
  const elapsed = day / daysInMonth;
  const daysLeft = Math.max(0, daysInMonth - day + 1);

  const parts = [];
  if (hasValue) parts.push(`${inr(achieved.salesValue)} of ${inr(target.salesTarget)}`);
  if (hasCount) parts.push(`${achieved.bookings} of ${target.bookingsTarget} bookings`);
  const progress = parts.join(' · ');

  if (pct >= 1) {
    return {
      title: `🎉 ${monthLabel} target achieved already!`,
      body: `You've reached ${pctText} of your target by mid-month (${progress}). Keep it going!`,
    };
  }
  const remaining = Math.max(0, (target.salesTarget || 0) - achieved.salesValue);
  const pace = hasValue && daysLeft > 0
    ? ` ${inr(remaining)} to go — about ${inr(remaining / daysLeft)} a day for the next ${daysLeft} days.`
    : hasCount
      ? ` ${Math.max(0, target.bookingsTarget - achieved.bookings)} more bookings to go in ${daysLeft} days.`
      : '';
  if (pct >= elapsed * 0.9) {
    return {
      title: `Mid-month check: ${pctText} of your ${monthLabel} target`,
      body: `You're on track (${progress}).${pace}`,
    };
  }
  return {
    title: `Mid-month check: ${pctText} of your ${monthLabel} target`,
    body: `You're behind pace (${progress}).${pace}`,
  };
};

/// Pure: share of target reached (value target first, else bookings target).
const shareOf = (target, achieved) =>
  (target.salesTarget || 0) > 0
    ? achieved.salesValue / target.salesTarget
    : (target.bookingsTarget || 0) > 0
      ? achieved.bookings / target.bookingsTarget
      : 0;

/// Pure: the sales manager's team summary. `rows` = [{ name, target, achieved }].
export const buildTeamMessage = ({ rows, monthLabel, day, daysInMonth }) => {
  const elapsed = day / daysInMonth;
  const valueTarget = rows.reduce((s, r) => s + (r.target.salesTarget || 0), 0);
  const valueDone = rows.reduce((s, r) => s + (r.target.salesTarget > 0 ? r.achieved.salesValue : 0), 0);
  const withShare = rows.map((r) => ({ ...r, share: shareOf(r.target, r.achieved) }));
  const hit = withShare.filter((r) => r.share >= 1);
  const onTrack = withShare.filter((r) => r.share < 1 && r.share >= elapsed * 0.9);
  const behind = withShare.filter((r) => r.share < elapsed * 0.9).sort((a, b) => a.share - b.share);
  const teamPct = valueTarget > 0 ? valueDone / valueTarget : null;
  const pct = (x) => `${Math.floor(x * 100)}%`;

  const counts = [
    hit.length && `${hit.length} hit`,
    onTrack.length && `${onTrack.length} on track`,
    behind.length && `${behind.length} behind`,
  ].filter(Boolean).join(', ');
  const lines = [];
  if (teamPct != null) lines.push(`Team at ${pct(teamPct)} (${inr(valueDone)} of ${inr(valueTarget)}).`);
  lines.push(`${rows.length} salespeople: ${counts}.`);
  if (behind.length) {
    const names = behind.slice(0, 3).map((r) => `${r.name} ${pct(r.share)}`).join(', ');
    lines.push(`Needs attention: ${names}${behind.length > 3 ? ` +${behind.length - 3} more` : ''}.`);
  }
  if (hit.length) {
    lines.push(`Already hit: ${hit.slice(0, 3).map((r) => r.name).join(', ')}${hit.length > 3 ? ' …' : ''}.`);
  }
  return {
    title: `Mid-month team check: ${teamPct != null ? `${pct(teamPct)} of ` : ''}${monthLabel} target`,
    body: lines.join(' '),
  };
};

export const sweepSalesTargetMidMonth = async () => {
  const nowMs = Date.now();
  if (nowMs - lastCheckAt < CHECK_EVERY_MS) return;
  lastCheckAt = nowMs;

  try {
    const ist = new Date(nowMs + IST_OFFSET_MS);
    const day = istDay(new Date(nowMs));
    if (day < MID_MONTH_DAY) return;
    const month = ist.getUTCMonth() + 1;
    const year = ist.getUTCFullYear();
    // One notification per person per month — keyed by the month.
    const periodKey = new Date(Date.UTC(year, month - 1, 1));

    const allTargets = await SalesTarget.find({
      month,
      year,
      $or: [{ salesTarget: { $gt: 0 } }, { bookingsTarget: { $gt: 0 } }],
    }).lean();
    // Sales managers' targets roll up from the team (they get the team
    // summary below), so any stored manager target is ignored here.
    const managerIdsWithTarget = new Set(
      (await User.find({ _id: { $in: allTargets.map((t) => t.userId) }, role: { $regex: /^sales.*manager$/i } })
        .select('_id')
        .lean()).map((u) => String(u._id))
    );
    const targets = allTargets.filter((t) => !managerIdsWithTarget.has(String(t.userId)));
    if (targets.length === 0) return;

    const sentTo = async (type) =>
      new Set(
        (await Notification.find({ type, forDate: periodKey }).select('recipient').lean())
          .map((n) => String(n.recipient))
      );
    const alreadySent = await sentTo(NOTIFICATION_TYPES.SALES_TARGET_MIDMONTH);
    const pending = targets.filter((t) => !alreadySent.has(String(t.userId)));

    // Sales managers (e.g. 'sales_manager') still owed this month's summary.
    const teamSent = await sentTo(NOTIFICATION_TYPES.SALES_TARGET_TEAM_MIDMONTH);
    const managers = (
      await User.find({ role: { $regex: /^sales.*manager$/i }, active: { $ne: false } })
        .select('_id')
        .lean()
    ).filter((m) => !teamSent.has(String(m._id)));
    if (pending.length === 0 && managers.length === 0) return;

    const achievement = await monthAchievement(month, year);
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const monthLabel = MONTHS[month - 1];

    for (const t of pending) {
      const a = achievement.get(String(t.userId)) ?? { salesValue: 0, bookings: 0 };
      const { title, body } = buildMidMonthMessage({
        target: t,
        achieved: a,
        monthLabel,
        day,
        daysInMonth,
      });
      await notify({
        recipients: [t.userId],
        type: NOTIFICATION_TYPES.SALES_TARGET_MIDMONTH,
        title,
        body,
        link: '/sales/home',
        forDate: periodKey,
        dedupe: true,
      });
    }

    if (managers.length) {
      const names = new Map(
        (await User.find({ _id: { $in: targets.map((t) => t.userId) } }).select('name').lean())
          .map((u) => [String(u._id), u.name || 'Unnamed'])
      );
      const { title, body } = buildTeamMessage({
        rows: targets.map((t) => ({
          name: names.get(String(t.userId)) ?? 'Unnamed',
          target: t,
          achieved: achievement.get(String(t.userId)) ?? { salesValue: 0, bookings: 0 },
        })),
        monthLabel,
        day,
        daysInMonth,
      });
      await notify({
        recipients: managers.map((m) => m._id),
        type: NOTIFICATION_TYPES.SALES_TARGET_TEAM_MIDMONTH,
        title,
        body,
        link: '/sales/targets',
        forDate: periodKey,
        dedupe: true,
      });
    }
  } catch (err) {
    console.error('sweepSalesTargetMidMonth failed:', err.message);
  }
};
