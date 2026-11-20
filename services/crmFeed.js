// The CRM dashboard's recent activities and upcoming trials (shaping: utils/crmFeed.js). A member sees only what is theirs.
import Booking from '../models/Booking.js';
import Conversation from '../models/Conversation.js';
import CrmCase from '../models/CrmCase.js';
import Message from '../models/Message.js';
import Review from '../models/Review.js';
import Trial from '../models/Trial.js';
import { istDayKey } from '../utils/istDate.js';
import { caseEvents, chatEvents, mergeFeed, requestEvents, reviewEvents, trialLine } from '../utils/crmFeed.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The newest things that happened in the CRM (two weeks back at most), newest first. */
export const recentCrmActivity = async ({ memberId = null, now = new Date(), limit = 8 } = {}) => {
  const since = new Date(now.getTime() - 14 * DAY_MS);
  const mine = (field) => (memberId ? { [field]: memberId } : {});
  const convoFilter = memberId ? { assignedStaffId: memberId } : {};
  const [bookings, convos, cases, reviews] = await Promise.all([
    Booking.find({ origin: 'public', $or: [{ createdAt: { $gte: since } }, { 'statusHistory.0.at': { $gte: since } }, { requestDecidedAt: { $gte: since } }], ...mine('crmOwnerId') })
      .select('customerName createdAt statusHistory requestDecision requestDecidedAt requestDecidedByName')
      .sort({ updatedAt: -1 })
      .limit(40)
      .lean(),
    Conversation.find({ lastMessageAt: { $gte: since }, ...convoFilter }).select('clientName lastMessageAt').sort({ lastMessageAt: -1 }).limit(20).lean(),
    CrmCase.find({ $or: [{ createdAt: { $gte: since } }, { 'activities.at': { $gte: since } }], ...mine('ownerId') })
      .select('caseNumber title customerName status createdAt activities.type activities.text activities.at activities.byName')
      .sort({ updatedAt: -1 })
      .limit(30)
      .lean(),
    memberId ? [] : Review.find({ submittedAt: { $gte: since } }).select('brideName nps submittedAt').sort({ submittedAt: -1 }).limit(limit).lean(),
  ]);
  const messages = convos.length
    ? await Message.find({ conversationId: { $in: convos.map((c) => c._id) }, createdAt: { $gte: since }, senderType: { $in: ['client', 'staff'] } }).select('conversationId senderType createdAt').sort({ createdAt: -1 }).limit(200).lean()
    : [];
  return mergeFeed([requestEvents(bookings, since), chatEvents(messages, convos), caseEvents(cases, since), reviewEvents(reviews, since)], limit);
};

/** The next trials from today (IST) — scheduled or postponed — soonest first. */
export const upcomingCrmTrials = async ({ memberId = null, now = new Date(), limit = 5 } = {}) => {
  const trials = await Trial.find({ trialDate: { $gte: istDayKey(now) }, status: { $in: ['scheduled', 'postponed'] }, ...(memberId ? { crmOwnerId: memberId } : {}) })
    .select('trialNumber clientName trialDate startTime status trialItems.packageName trialItems.lookLabel assignedStaff.artistName crmOwnerName')
    .sort({ trialDate: 1, startTime: 1 })
    .limit(limit)
    .lean();
  return trials.map(trialLine);
};
