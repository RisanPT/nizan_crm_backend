import Consultation from '../models/Consultation.js';
import {
  MANAGER_AND_ADMIN_ROLES,
  NOTIFICATION_TYPES,
  getUserIdsByPermission,
  getUserIdsByRoles,
  notify,
} from './notify.js';
import {
  REMINDER_TIERS,
  buildConsultationNotice,
  dueReminderKey,
  tiersUpTo,
} from './consultationRules.js';

// Notifications for the stylist consultation module. Every function is
// best-effort: a notification problem must never fail the booking, reschedule
// or cancellation that triggered it (notify() itself never throws; the DB calls
// around it are guarded here).

const idOf = (v) => (v == null ? null : v._id ?? v);
const link = (consultation) => `/consultations/${consultation._id}`;

// The client file's name; a call made before client files existed only has the lead.
const clientNameOf = (consultation) => consultation.clientId?.name || consultation.leadId?.name || '';

/// Tell a stylist about a booking / change made by someone else.
/// kind: assigned | rescheduled | cancelled | reassigned
export const notifyStylist = async (
  kind,
  consultation,
  { recipientId, actor, toStylistName, scheduledAt } = {}
) => {
  try {
    const recipient = recipientId ?? idOf(consultation.stylistId);
    if (!recipient) return;
    const { title, body } = buildConsultationNotice(kind, {
      clientName: clientNameOf(consultation),
      // 'reassigned' describes the slot the previous stylist lost.
      scheduledAt: scheduledAt ?? consultation.scheduledAt,
      actorName: actor?.name,
      toStylistName,
    });
    await notify({
      recipients: [recipient],
      type:
        kind === 'assigned'
          ? NOTIFICATION_TYPES.CONSULTATION_ASSIGNED
          : NOTIFICATION_TYPES.CONSULTATION_CHANGED,
      title,
      body,
      leadId: idOf(consultation.leadId),
      link: link(consultation),
      createdBy: actor?._id ?? null,
      // The person who made the change already knows about it.
      excludeUserId: actor?._id ?? null,
    });
  } catch (err) {
    console.error('notifyStylist failed:', err.message);
  }
};

/// A new enquiry arrived: tell the stylist leads (roles granted the whole
/// `consultations` module, as opposed to a stylist's sub-permissions only) so
/// someone can review it and arrange the consultation. Managers/admins already
/// get the regular new-lead notice, so they are left out here.
export const notifyStylistLeadsOfNewLead = async (lead, actor) => {
  try {
    const [leadIds, managerIds] = await Promise.all([
      getUserIdsByPermission('consultations'),
      getUserIdsByRoles(MANAGER_AND_ADMIN_ROLES),
    ]);
    const managers = new Set(managerIds.map(String));
    const recipients = leadIds.filter((id) => !managers.has(String(id)));
    if (recipients.length === 0) return;
    await notify({
      recipients,
      type: NOTIFICATION_TYPES.NEW_LEAD,
      title: 'New enquiry',
      body: `${lead.name} enquired${lead.source ? ` via ${lead.source}` : ''}${actor?.name ? ` (added by ${actor.name})` : ''}.`,
      leadId: lead._id,
      createdBy: actor?._id ?? null,
      excludeUserId: actor?._id ?? null,
    });
  } catch (err) {
    console.error('notifyStylistLeadsOfNewLead failed:', err.message);
  }
};

// ── Time-based reminders ────────────────────────────────────────────────────
// Like the lead follow-up sweep these have no user action to hang off, so they
// are generated lazily whenever notifications are fetched (see
// notificationController.getNotifications), throttled so many polling clients
// do not each pay for it. Each reminder is CLAIMED with an atomic update on
// Consultation.remindersSent, so two overlapping sweeps can never both send it.
let lastReminderSweepAt = 0;
const REMINDER_SWEEP_INTERVAL_MS = 60 * 1000;
const SWEEP_LIMIT = 300;

export const sweepConsultationReminders = async () => {
  const nowMs = Date.now();
  if (nowMs - lastReminderSweepAt < REMINDER_SWEEP_INTERVAL_MS) return;
  lastReminderSweepAt = nowMs;

  try {
    const now = new Date(nowMs);
    const horizon = new Date(nowMs + REMINDER_TIERS[0].ms);

    const upcoming = await Consultation.find({
      status: 'Scheduled',
      scheduledAt: { $gt: now, $lte: horizon },
    })
      .select('_id leadId clientId stylistId scheduledAt mode remindersSent')
      .populate('leadId', 'name')
      .populate('clientId', 'name')
      .sort({ scheduledAt: 1 })
      .limit(SWEEP_LIMIT);

    for (const c of upcoming) {
      const key = dueReminderKey(c.scheduledAt, now);
      if (!key || (c.remindersSent ?? []).includes(key)) continue;

      // Claim it. A null result means another sweep (or a reschedule/cancel)
      // got there first, so do nothing.
      const claimed = await Consultation.findOneAndUpdate(
        { _id: c._id, status: 'Scheduled', remindersSent: { $ne: key } },
        { $addToSet: { remindersSent: { $each: tiersUpTo(key) } } },
        { new: false }
      ).select('_id');
      if (!claimed) continue;

      const { title, body } = buildConsultationNotice(`reminder-${key}`, {
        clientName: clientNameOf(c),
        scheduledAt: c.scheduledAt,
        isVideo: c.mode === 'Video',
        now,
      });
      await notify({
        recipients: [idOf(c.stylistId)],
        type: NOTIFICATION_TYPES.CONSULTATION_REMINDER,
        title,
        body,
        leadId: idOf(c.leadId),
        link: link(c),
        // The nominal fire time is distinct per tier and per slot, so
        // (recipient, type, lead, forDate) is a second guard against a
        // duplicate — without the 1h reminder being mistaken for the 24h one.
        forDate: new Date(
          new Date(c.scheduledAt).getTime() - REMINDER_TIERS.find((t) => t.key === key).ms
        ),
        dedupe: true,
      });
    }
  } catch (err) {
    console.error('sweepConsultationReminders failed:', err.message);
  }
};
