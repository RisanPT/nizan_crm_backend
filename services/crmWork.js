import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import Conversation from '../models/Conversation.js';
import CrmCase from '../models/CrmCase.js';
import Trial from '../models/Trial.js';
import { requestArrivedAt } from '../utils/crmBookingAudit.js';
import { isOverdue } from '../utils/crmCaseRules.js';
import { addDays, todayIst } from '../utils/istDate.js';
import { caseKindLabel } from './crmCases.js';
import { PENDING_STATUS } from './crmSweep.js';

// The CRM team's OPEN WORK, read from the records themselves: the queue (booking requests waiting for a decision, chats waiting for an
// answer, open cases, trials still to report on) and each owner's workload. Used by /api/crm (queue, team), the CRM dashboard and its
// report.

const HOUR_MS = 3600 * 1000;
const MIN_MS = 60 * 1000;
const idOf = (v) => (v == null ? '' : String(v._id ?? v));
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const OPEN_CASE = ['open', 'in_progress'];

const QUEUE_LIMIT = 300;

export const ownerFilter = ({ scope, ownerId }, field) => {
  if (scope === 'unassigned') return { [field]: null };
  if (ownerId) return { [field]: oid(ownerId) };
  return {};
};

const eventDayOf = (b) => {
  const d = b.selectedDates?.[0] ?? b.bookingDate ?? b.serviceStart;
  return d ? new Date(d) : null;
};

/// The work that waits, as one list: [{ type, id, title, subtitle, phone, ownerId, ownerName, since, dueAt, overdue, status, link }].
export const loadQueue = async (who, types, settings, now = new Date()) => {
  const items = [];
  const at = now.getTime();

  if (types.includes('booking')) {
    const rows = await Booking.find({ status: PENDING_STATUS, ...ownerFilter(who, 'crmOwnerId') })
      .select('customerName phone service bookingNumber bookingDate selectedDates serviceStart createdAt statusHistory crmOwnerId crmOwnerName')
      .sort({ createdAt: 1 })
      .limit(QUEUE_LIMIT)
      .lean();
    for (const b of rows) {
      const since = requestArrivedAt(b);
      const dueAt = since ? new Date(new Date(since).getTime() + settings.requestSlaHours * HOUR_MS) : null;
      const event = eventDayOf(b);
      items.push({
        type: 'booking',
        id: idOf(b._id),
        title: b.customerName || 'Booking request',
        subtitle: [b.bookingNumber, b.service, event && !Number.isNaN(event.getTime()) ? `event ${event.toISOString().slice(0, 10)}` : ''].filter(Boolean).join(' · '),
        phone: b.phone || '',
        ownerId: b.crmOwnerId ? idOf(b.crmOwnerId) : null,
        ownerName: b.crmOwnerName || '',
        since,
        dueAt,
        overdue: !!dueAt && dueAt.getTime() < at,
        status: 'pending',
        link: '/booking/requests',
      });
    }
  }

  if (types.includes('conversation')) {
    const rows = await Conversation.find({ status: 'open', awaitingSince: { $ne: null }, ...ownerFilter(who, 'assignedStaffId') })
      .select('clientName clientPhone lastMessagePreview awaitingSince assignedStaffId assignedStaffName')
      .sort({ awaitingSince: 1 })
      .limit(QUEUE_LIMIT)
      .lean();
    for (const c of rows) {
      const dueAt = new Date(new Date(c.awaitingSince).getTime() + settings.chatResponseSlaMins * MIN_MS);
      items.push({
        type: 'conversation',
        id: idOf(c._id),
        title: c.clientName || c.clientPhone || 'Client chat',
        subtitle: c.lastMessagePreview || 'Waiting for an answer',
        phone: c.clientPhone || '',
        ownerId: c.assignedStaffId ? idOf(c.assignedStaffId) : null,
        ownerName: c.assignedStaffName || '',
        since: c.awaitingSince,
        dueAt,
        overdue: dueAt.getTime() < at,
        status: 'waiting',
        link: `/client-chat/${idOf(c._id)}`,
      });
    }
  }

  if (types.includes('case')) {
    const rows = await CrmCase.find({ status: { $in: OPEN_CASE }, ...ownerFilter(who, 'ownerId') })
      .select('caseNumber kind title customerName phone priority status ownerId ownerName dueAt createdAt')
      .sort({ dueAt: 1 })
      .limit(QUEUE_LIMIT)
      .lean();
    for (const c of rows) {
      items.push({
        type: 'case',
        id: idOf(c._id),
        title: c.customerName || c.title,
        subtitle: [c.caseNumber, caseKindLabel(c.kind), c.priority === 'high' ? 'high priority' : ''].filter(Boolean).join(' · '),
        phone: c.phone || '',
        ownerId: c.ownerId ? idOf(c.ownerId) : null,
        ownerName: c.ownerName || '',
        since: c.createdAt,
        dueAt: c.dueAt,
        overdue: isOverdue(c, now),
        status: c.status,
        kind: c.kind,
        priority: c.priority,
        link: `/crm/cases/${idOf(c._id)}`,
      });
    }
  }

  if (types.includes('trial')) {
    const today = todayIst();
    const rows = await Trial.find({ status: 'scheduled', trialDate: { $gte: addDays(today, -30) }, ...ownerFilter(who, 'crmOwnerId') })
      .select('trialNumber clientName phone trialDate startTime crmOwnerId crmOwnerName createdAt')
      .sort({ trialDate: 1 })
      .limit(QUEUE_LIMIT)
      .lean();
    for (const t of rows) {
      items.push({
        type: 'trial',
        id: idOf(t._id),
        title: t.clientName || 'Trial',
        subtitle: [t.trialNumber, `trial ${t.trialDate}${t.startTime ? ` ${t.startTime}` : ''}`].filter(Boolean).join(' · '),
        phone: t.phone || '',
        ownerId: t.crmOwnerId ? idOf(t.crmOwnerId) : null,
        ownerName: t.crmOwnerName || '',
        since: t.createdAt,
        dueAt: new Date(`${t.trialDate}T23:59:59.999+05:30`),
        // still "scheduled" after its day: somebody has to say how it went
        overdue: t.trialDate < today,
        status: 'scheduled',
        link: `/trials/${idOf(t._id)}`,
      });
    }
  }

  const dueKey = (i) => (i.dueAt ? new Date(i.dueAt).getTime() : Number.MAX_SAFE_INTEGER);
  items.sort((a, b) => Number(b.overdue) - Number(a.overdue) || dueKey(a) - dueKey(b));
  return items;
};

export const emptyLoad = () => ({ requests: 0, chats: 0, cases: 0, trials: 0, overdue: 0, total: 0 });

/// Open work per owner (null = unassigned): Map(ownerId|'' → { requests, chats, cases, trials, overdue, total, name }).
export const workloadByOwner = async (settings, now = new Date()) => {
  const requestCut = new Date(now.getTime() - settings.requestSlaHours * HOUR_MS);
  const chatCut = new Date(now.getTime() - settings.chatResponseSlaMins * MIN_MS);
  const today = todayIst();
  const [requests, chats, cases, trials] = await Promise.all([
    Booking.aggregate([
      { $match: { status: PENDING_STATUS } },
      { $group: { _id: '$crmOwnerId', n: { $sum: 1 }, overdue: { $sum: { $cond: [{ $lt: ['$createdAt', requestCut] }, 1, 0] } }, name: { $first: '$crmOwnerName' } } },
    ]),
    Conversation.aggregate([
      { $match: { status: 'open', awaitingSince: { $ne: null } } },
      { $group: { _id: '$assignedStaffId', n: { $sum: 1 }, overdue: { $sum: { $cond: [{ $lt: ['$awaitingSince', chatCut] }, 1, 0] } }, name: { $first: '$assignedStaffName' } } },
    ]),
    CrmCase.aggregate([
      { $match: { status: { $in: OPEN_CASE } } },
      { $group: { _id: '$ownerId', n: { $sum: 1 }, overdue: { $sum: { $cond: [{ $lt: ['$dueAt', now] }, 1, 0] } }, name: { $first: '$ownerName' } } },
    ]),
    Trial.aggregate([
      { $match: { status: 'scheduled', trialDate: { $gte: addDays(today, -30) } } },
      { $group: { _id: '$crmOwnerId', n: { $sum: 1 }, overdue: { $sum: { $cond: [{ $lt: ['$trialDate', today] }, 1, 0] } }, name: { $first: '$crmOwnerName' } } },
    ]),
  ]);
  const map = new Map();
  const add = (rows, key) => {
    for (const r of rows) {
      const id = r._id ? String(r._id) : '';
      const w = map.get(id) ?? { ...emptyLoad(), name: '' };
      w[key] += r.n;
      w.overdue += r.overdue;
      w.total += r.n;
      if (!w.name && r.name) w.name = r.name;
      map.set(id, w);
    }
  };
  add(requests, 'requests');
  add(chats, 'chats');
  add(cases, 'cases');
  add(trials, 'trials');
  return map;
};
