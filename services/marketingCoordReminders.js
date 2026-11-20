import CoordFollowUp from '../models/CoordFollowUp.js';
import { MarketingTeamMember } from '../models/MarketingEod.js';
import User from '../models/User.js';
import { notify, NOTIFICATION_TYPES } from '../utils/notify.js';
import { followUpReminderKind } from '../utils/marketingCoordinationStats.js';
import { istDay } from '../utils/marketingTeamStats.js';

// Coordinations → Follow-ups: the reminder a follow-up asks for (`reminder` on). When it falls due its OWNER is told in the app — or, if
// it is first seen after its day, that it is overdue — ONCE per due day: the follow-up is claimed with an atomic stamp (`remindedFor` =
// the due day) before anything is sent, so two servers, two ticks or two page reads can never send it twice. Moving the due day arms it
// again (utils/marketingCoordinationStats.js followUpReminderKind is the rule).
//
// Who is told: the owner's linked login; an owner with no login (or typed by name only) → the person who made the follow-up.
// It runs from the reminder scheduler (services/marketingEodReminders.js, every 10 minutes from 08:00 IST) and, so it never depends on
// a scheduler being up, whenever Coordinations' Follow-ups or Overview is read (sweepFollowUpReminders — at most once a minute).

// NOTIFICATION_TYPES has no follow-up-reminder key yet (utils/notify.js is shared); the app shows an unknown type with the default bell.
export const COORD_FOLLOWUP_DUE = NOTIFICATION_TYPES.COORD_FOLLOWUP_DUE ?? 'coord_followup_due';

/** The login to tell about a follow-up: its owner's (when linked and active), else its maker's. */
const recipientOf = async (f) => {
  if (f.ownerId) {
    const m = await MarketingTeamMember.findById(f.ownerId).select('userId').lean();
    if (m?.userId && (await User.exists({ _id: m.userId, active: { $ne: false } }))) return m.userId;
  }
  return f.createdBy ?? null;
};

/** Send every reminder that is due now. → { sent, checked } */
export const runFollowUpReminders = async (now = new Date()) => {
  const today = istDay(now);
  const candidates = await CoordFollowUp.find({ reminder: true, status: 'open', dueDate: { $lte: today }, $expr: { $ne: ['$remindedFor', '$dueDate'] } })
    .select('item relatedTo ownerId ownerName dueDate status reminder remindedFor createdBy')
    .limit(500)
    .lean();
  let sent = 0;
  for (const f of candidates) {
    const kind = followUpReminderKind(f, today);
    if (!kind) continue;
    // claim it first: only the call that flips the stamp sends
    const claimed = await CoordFollowUp.findOneAndUpdate(
      { _id: f._id, reminder: true, status: 'open', dueDate: f.dueDate, remindedFor: { $ne: f.dueDate } },
      { $set: { remindedFor: f.dueDate, remindedAt: now } },
      { new: true },
    ).lean();
    if (!claimed) continue;
    const to = await recipientOf(claimed);
    if (!to) continue;
    await notify({
      recipients: [to],
      type: COORD_FOLLOWUP_DUE,
      title: kind === 'due' ? 'Follow-up due today' : 'Follow-up overdue',
      body: `${claimed.item}${claimed.relatedTo ? ` (${claimed.relatedTo})` : ''} — ${kind === 'due' ? 'due today' : `was due ${claimed.dueDate}`}`,
      link: '/marketing/coordinations?tab=followups',
      forDate: new Date(`${claimed.dueDate}T00:00:00.000Z`),
    });
    sent += 1;
  }
  return { sent, checked: candidates.length };
};

let lastSweep = 0;
/** The sweep a page read makes: at most once a minute per server; never throws (a reminder must not break the page). */
export const sweepFollowUpReminders = async (now = new Date()) => {
  if (now.getTime() - lastSweep < 60 * 1000) return { sent: 0, skipped: true };
  lastSweep = now.getTime();
  try {
    return await runFollowUpReminders(now);
  } catch (e) {
    console.error('[Coordinations] follow-up reminder sweep failed:', e?.message || e);
    return { sent: 0, failed: true };
  }
};

/** For tests: let the next read sweep again. */
export const _resetFollowUpSweep = () => {
  lastSweep = 0;
};
