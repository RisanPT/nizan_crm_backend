import Booking from '../models/Booking.js';
import Conversation from '../models/Conversation.js';
import CrmCase from '../models/CrmCase.js';
import { getCrmSettings } from './crmSettings.js';
import { crmHeadIds } from './crmTeam.js';
import { notify, NOTIFICATION_TYPES } from '../utils/notify.js';

// OVERDUE ALERTS for the CRM team. There is no cron: this runs when a CRM screen is read (at most once every 5 minutes) and tells the
// owner and the CRM Head about work that has gone past its time limit:
//   • a booking request still pending after `requestSlaHours` (only requests that arrived since the CRM records began — the backlog
//     from before is handed out by the head, not announced one by one);
//   • a client chat waiting for an answer for `chatUnansweredHours`;
//   • a case past its due time.
// Each item is STAMPED atomically before anyone is told, so it is announced exactly once however many sweeps run (a chat again only
// after it is answered and the client writes again; a case again only after it is reopened or given a later due time). Everyone
// gets ONE notification per sweep with their count, not one per item.

const HOUR_MS = 3600 * 1000;
const THROTTLE_MS = 5 * 60 * 1000;
const BATCH = 500;
export const PENDING_STATUS = /^\s*pending\s*$/i;

let lastRunAt = 0;

/// Tests only: let the next sweep run at once.
export const _resetCrmSweep = () => {
  lastRunAt = 0;
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/// Stamps each of [docs] on [model] (field [stamp] from null to [now]); returns the ones THIS call stamped — a doc another sweep
/// stamped since it was read is not this one's to announce. (Exported for the tests.)
export const claimEach = async (model, docs, stamp, now) => {
  const won = [];
  for (const d of docs) {
    const r = await model.updateOne({ _id: d._id, [stamp]: null }, { $set: { [stamp]: now } }, { timestamps: false });
    if (r.modifiedCount === 1) won.push(d);
  }
  return won;
};

/**
 * One sweep. Returns { requests, chats, cases, recipients } (the items announced now), or null when a sweep ran less than 5 minutes
 * ago (pass `force` to run anyway).
 */
export const runCrmSweep = async ({ now = new Date(), force = false } = {}) => {
  if (!force && now.getTime() - lastRunAt < THROTTLE_MS) return null;
  lastRunAt = now.getTime();

  const settings = await getCrmSettings();
  const heads = (await crmHeadIds()).map(String);

  const requestCut = new Date(now.getTime() - settings.requestSlaHours * HOUR_MS);
  const requests = await claimEach(
    Booking,
    await Booking.find({
      status: PENDING_STATUS,
      crmOverdueNotifiedAt: null,
      createdAt: { $lte: requestCut, $gte: settings.trackingSince },
    })
      .select('_id crmOwnerId')
      .limit(BATCH)
      .lean(),
    'crmOverdueNotifiedAt',
    now
  );

  const chatCut = new Date(now.getTime() - settings.chatUnansweredHours * HOUR_MS);
  const chats = await claimEach(
    Conversation,
    await Conversation.find({ status: 'open', awaitingSince: { $ne: null, $lte: chatCut }, awaitingNotifiedAt: null })
      .select('_id assignedStaffId')
      .limit(BATCH)
      .lean(),
    'awaitingNotifiedAt',
    now
  );

  const cases = await claimEach(
    CrmCase,
    await CrmCase.find({ status: { $in: ['open', 'in_progress'] }, dueAt: { $lt: now }, overdueNotifiedAt: null })
      .select('_id ownerId')
      .limit(BATCH)
      .lean(),
    'overdueNotifiedAt',
    now
  );

  // who hears about what: the owner of each item, and every CRM Head about all of them
  const tally = new Map();
  const count = (owner, kind) => {
    for (const id of new Set([owner ? String(owner) : null, ...heads].filter(Boolean))) {
      const t = tally.get(id) ?? { requests: 0, chats: 0, cases: 0 };
      t[kind] += 1;
      tally.set(id, t);
    }
  };
  for (const b of requests) count(b.crmOwnerId, 'requests');
  for (const c of chats) count(c.assignedStaffId, 'chats');
  for (const c of cases) count(c.ownerId, 'cases');

  for (const [id, t] of tally) {
    const parts = [
      t.requests && plural(t.requests, `booking request pending over ${settings.requestSlaHours} h`, `booking requests pending over ${settings.requestSlaHours} h`),
      t.chats && plural(t.chats, `client chat unanswered over ${settings.chatUnansweredHours} h`, `client chats unanswered over ${settings.chatUnansweredHours} h`),
      t.cases && plural(t.cases, 'case past its due time', 'cases past their due time'),
    ].filter(Boolean);
    try {
      await notify({
        recipients: [id],
        type: NOTIFICATION_TYPES.CRM_OVERDUE,
        title: 'CRM work is overdue',
        body: parts.join(' · '),
        link: heads.includes(id) ? '/crm/dashboard' : '/crm/my-work',
        copyAdmins: false, // a personal reminder sent to many: admins are not copied (utils/notify.js)
      });
    } catch (e) {
      console.error('crm overdue notify failed:', e.message);
    }
  }

  return { requests: requests.length, chats: chats.length, cases: cases.length, recipients: tally.size };
};

/// The sweep, for a read: never fails the read it rides on.
export const sweepQuietly = async () => {
  try {
    await runCrmSweep();
  } catch (e) {
    console.error('crm sweep failed:', e.message);
  }
};
